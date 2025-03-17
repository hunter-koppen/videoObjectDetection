import { createElement, useRef, useEffect, useState, Fragment } from "react";
import Webcam from "react-webcam";
import * as tf from "@tensorflow/tfjs";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

export function Camera(props) {
    const webcamRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const [model, setModel] = useState(null);
    const [detections, setDetections] = useState([]);
    const [isDetecting, setIsDetecting] = useState(false);
    const [cameraReady, setCameraReady] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [prevStartRecording, setPrevStartRecording] = useState(false);
    const [cameraError, setCameraError] = useState(null);

    // Tenserflow object detection
    const objectDetectionEnabled = props.objectDetectionEnabled === true;

    // Gemini
    const geminiEnabled = props.geminiEnabled === true;
    const geminiModelRef = useRef(null);
    const [geminiResponse, setGeminiResponse] = useState(props.geminiResponseOverride || "");
    const [isGeminiActive, setIsGeminiActive] = useState(props.geminiActiveOverride || false);
    const geminiSessionRef = useRef(null);

    useEffect(() => {
        if (!objectDetectionEnabled) return;

        const loadModel = async () => {
            try {
                const loadedModel = await cocoSsd.load();
                setModel(loadedModel);
                console.log("Object detection model loaded");
            } catch (err) {
                console.error("Failed to load model:", err);
            }
        };
        loadModel();
    }, [objectDetectionEnabled]);

    useEffect(() => {
        if (!objectDetectionEnabled) return;

        let animationFrameId;

        const runDetection = async () => {
            if (model && webcamRef.current && webcamRef.current.video && isDetecting) {
                const video = webcamRef.current.video;
                if (video.readyState !== 4 || !video.videoWidth || !video.videoHeight) {
                    animationFrameId = requestAnimationFrame(runDetection);
                    return;
                }
                try {
                    const predictions = await model.detect(video);
                    setDetections(predictions);
                    animationFrameId = requestAnimationFrame(runDetection);
                } catch (error) {
                    console.error("Detection error:", error);
                    setTimeout(() => {
                        animationFrameId = requestAnimationFrame(runDetection);
                    }, 1000);
                }
            }
        };

        if (isDetecting) {
            runDetection();
        }

        return () => {
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
            }
        };
    }, [model, isDetecting, objectDetectionEnabled]);

    // Gemini initialization
    useEffect(() => {
        if (!geminiEnabled) return;

        // Skip if camera isn't ready (for session creation) and if session already exists
        if (!cameraReady || geminiSessionRef.current) {
            return;
        }

        const initialPrompt =
            props.geminiInitialPrompt || "You are a real-time video analyzer. Describe what you see concisely.";

        try {
            console.log("Initializing Gemini model");
            const genAI = new GoogleGenerativeAI(props.geminiApiKey);
            const model = genAI.getGenerativeModel({
                model: "gemini-1.5-flash-latest",
                generationConfig: {
                    maxOutputTokens: 100
                },
                safetySettings: [
                    {
                        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
                    }
                ]
            });
            geminiModelRef.current = model;
            console.log("Gemini live model initialized");

            console.log("Starting Gemini session");
            const chat = model.startChat({
                history: [
                    {
                        role: "user",
                        parts: [
                            {
                                text: initialPrompt
                            }
                        ]
                    }
                ],
                generationConfig: {
                    maxOutputTokens: 100
                }
            });

            geminiSessionRef.current = chat;
            setIsGeminiActive(true);
            console.log("Gemini live session started");
        } catch (error) {
            console.error("Failed to initialize Gemini:", error);
            setIsGeminiActive(false);
            geminiSessionRef.current = null;
        }

        return () => {
            if (!cameraReady) return; // Don't clean up if we're just initializing the model
            setIsGeminiActive(false);
            geminiSessionRef.current = null;
        };
    }, [geminiEnabled, cameraReady, props.geminiApiKey, props.geminiInitialPrompt]);

    // Gemini timeout if no response
    useEffect(() => {
        if (isGeminiActive && !geminiResponse) {
            const timeoutId = setTimeout(() => {
                console.log("Gemini response timeout");
                setGeminiResponse("No response received from Gemini. The API may be unavailable.");
            }, 15000); // 15 seconds timeout

            return () => {
                clearTimeout(timeoutId);
            };
        }
    }, [isGeminiActive, geminiResponse]);

    // Gemini frame processing
    useEffect(() => {
        // Log the current state to help with debugging
        console.log("Gemini frame processing effect running with state:", {
            geminiEnabled,
            isGeminiActive,
            hasSession: !!geminiSessionRef.current,
            cameraReady
        });

        if (!geminiEnabled || !isGeminiActive || !geminiSessionRef.current || !cameraReady) {
            console.log("Skipping Gemini frame processing setup - conditions not met");
            return;
        }

        console.log("Setting up Gemini frame processing");

        // Calculate delay between frames based on frame rate
        const frameRate = props.geminiFrameRate || 0.5; // Default to 1 frame every 2 seconds
        const frameDelay = 1000 / frameRate;
        
        let isFrameProcessingActive = true;
        
        // Process frames sequentially with proper timing between them
        const processFrames = async () => {
            // Stop if component unmounted or conditions no longer valid
            if (!isFrameProcessingActive || !geminiSessionRef.current) {
                return;
            }
            
            try {
                // Take screenshot
                const screenshot = webcamRef.current?.getScreenshot();
                if (screenshot) {
                    const base64Data = screenshot.split(",")[1];
                    console.log("Sending frame to Gemini...");
                    
                    // Send to Gemini
                    const result = await geminiSessionRef.current.sendMessage([
                        {
                            inlineData: {
                                mimeType: "image/jpeg",
                                data: base64Data
                            }
                        },
                        { text: props.geminiFramePrompt || "What do you see in this frame?" }
                    ]);
                    
                    // Process response
                    const response = await result.response;
                    const text = response.text();
                    console.log("Received Gemini response:", text);
                    
                    if (isFrameProcessingActive) {
                        setGeminiResponse(text);
                        if (props.onGeminiResponse) {
                            props.onGeminiResponse(text);
                        }
                    }
                }
            } catch (error) {
                console.error("Gemini frame processing error:", error);
                if (isFrameProcessingActive) {
                    setGeminiResponse("Error analyzing video: " + error.message);
                }
            }
            
            // Schedule next frame with proper delay if still active
            if (isFrameProcessingActive) {
                setTimeout(processFrames, frameDelay);
            }
        };
        
        // Start the frame processing
        processFrames();
        
        // Cleanup function
        return () => {
            console.log("Cleaning up Gemini frame processing");
            isFrameProcessingActive = false;
        };
    }, [
        geminiEnabled,
        isGeminiActive,
        props.geminiFrameRate,
        props.geminiFramePrompt,
        props.onGeminiResponse,
        cameraReady
    ]);

    const renderDetections = () => {
        if (!objectDetectionEnabled || !detections.length) return null;

        return (
            <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}>
                {detections.map((detection, index) => (
                    <div
                        key={index}
                        style={{
                            position: "absolute",
                            border: "2px solid #00ff00",
                            backgroundColor: "rgba(0, 255, 0, 0.2)",
                            left: `${detection.bbox[0]}px`,
                            top: `${detection.bbox[1]}px`,
                            width: `${detection.bbox[2]}px`,
                            height: `${detection.bbox[3]}px`
                        }}
                    >
                        <span
                            style={{
                                position: "absolute",
                                top: "-1.5em",
                                backgroundColor: "#00ff00",
                                padding: "2px 6px",
                                color: "#fff",
                                fontSize: "12px"
                            }}
                        >
                            {detection.class} ({Math.round(detection.score * 100)}%)
                        </span>
                    </div>
                ))}
            </div>
        );
    };

    const handleUserMedia = () => {
        console.log("Camera stream initialized successfully");
        setCameraError(null);
        setCameraReady(true);
        if (objectDetectionEnabled) {
            setIsDetecting(true);
        }
    };

    const handleCameraError = error => {
        console.error("Camera error:", error);
        setCameraError("Failed to access camera: " + error.message);
    };

    const startRecording = () => {
        if (webcamRef.current && webcamRef.current.stream) {
            const chunks = [];
            const mediaRecorder = new MediaRecorder(webcamRef.current.stream);
            mediaRecorderRef.current = mediaRecorder;
            mediaRecorder.ondataavailable = event => {
                if (event.data.size > 0) {
                    chunks.push(event.data);
                    if (mediaRecorder.state !== "recording") {
                        const videoBlob = new Blob(chunks, { type: "video/webm" });
                        const reader = new FileReader();
                        reader.readAsDataURL(videoBlob);
                        reader.onloadend = () => {
                            const base64String = reader.result.split(",")[1];
                            if (props.onRecordingComplete) {
                                props.onRecordingComplete(base64String);
                            }
                        };
                        setIsRecording(false);
                    }
                }
            };
            mediaRecorder.start();
            setIsRecording(true);
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current) {
            mediaRecorderRef.current.stop();
        }
    };

    useEffect(() => {
        if (props.takeScreenshot.value === true && webcamRef.current) {
            const screenshot = webcamRef.current.getScreenshot();
            if (props.onScreenshot && screenshot) {
                props.takeScreenshot.setValue(false);
                const base64String = screenshot.split(",")[1];
                props.onScreenshot(base64String);
            }
        }
    }, [props.takeScreenshot, props.onScreenshot]);

    useEffect(() => {
        if (!props.startRecording) {
            return;
        }

        if (props.startRecording.value === true && !prevStartRecording) {
            startRecording();
        } else if (props.startRecording.value === false && prevStartRecording) {
            stopRecording();
        }
        setPrevStartRecording(props.startRecording.value);
    }, [props.startRecording?.value]);

    const videoConstraints = {
        facingMode: props.facingMode || "environment"
    };

    const renderGeminiResponse = () => {
        if (!geminiEnabled) return null;

        console.log("Rendering Gemini response:", {
            isActive: isGeminiActive,
            hasResponse: !!geminiResponse,
            responseLength: geminiResponse?.length
        });

        return (
            <div className="gemini-response">
                {!isGeminiActive && <div className="gemini-status">Gemini Live inactive</div>}

                {isGeminiActive && !geminiResponse && (
                    <div className="gemini-loading">
                        <div className="loading-dots">
                            {[0, 1, 2].map(i => (
                                <div key={i} className="loading-dot"></div>
                            ))}
                        </div>
                        <span>Analyzing video... (API Key: {props.geminiApiKey ? "Provided" : "Missing"})</span>
                    </div>
                )}

                {geminiResponse && (
                    <div className="gemini-content">
                        <div className="gemini-message">
                            <div className="gemini-avatar">G</div>
                            <div>{geminiResponse}</div>
                        </div>
                    </div>
                )}

                {props.showGeminiControls && (
                    <div className="gemini-controls">
                        <button
                            onClick={() => {
                                console.log("Clear button clicked");
                                setGeminiResponse("");
                                if (props.onGeminiResponse) {
                                    props.onGeminiResponse("");
                                }
                            }}
                            className="gemini-button"
                        >
                            Clear
                        </button>
                        <button
                            onClick={() => {
                                console.log("Toggle button clicked, current state:", isGeminiActive);
                                const newState = !isGeminiActive;
                                setIsGeminiActive(newState);

                                if (newState && geminiModelRef.current && !geminiSessionRef.current) {
                                    console.log("Restarting Gemini session");
                                    const startGeminiLiveSession = async () => {
                                        try {
                                            const chat = geminiModelRef.current.startChat({
                                                history: [
                                                    {
                                                        role: "user",
                                                        parts: [
                                                            {
                                                                text:
                                                                    props.geminiInitialPrompt ||
                                                                    "You are a real-time video analyzer. Describe what you see concisely."
                                                            }
                                                        ]
                                                    }
                                                ]
                                            });
                                            geminiSessionRef.current = chat;
                                            console.log("Gemini session restarted successfully");
                                        } catch (error) {
                                            console.error("Failed to restart Gemini session:", error);
                                            setGeminiResponse("Failed to start Gemini: " + error.message);
                                        }
                                    };
                                    startGeminiLiveSession();
                                }
                            }}
                            className={`gemini-button ${isGeminiActive ? "danger" : "primary"}`}
                        >
                            {isGeminiActive ? "Pause" : "Resume"}
                        </button>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className={"mx-camerastream " + props.classNames} style={{ width: props.width, height: props.height }}>
            {cameraError ? (
                <div
                    className="camera-error"
                    style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: "#000",
                        color: "#fff",
                        padding: "20px",
                        textAlign: "center"
                    }}
                >
                    {cameraError}
                </div>
            ) : (
                <Webcam
                    ref={webcamRef}
                    screenshotFormat="image/jpeg"
                    audio={props.audioEnabled}
                    videoConstraints={videoConstraints}
                    onUserMedia={handleUserMedia}
                    onUserMediaError={handleCameraError}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
            )}

            {renderDetections()}

            {geminiEnabled && renderGeminiResponse()}

            {!cameraReady && !cameraError && props.loadingContent && (
                <div
                    className="camera-loading"
                    style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: "rgba(0,0,0,0.5)",
                        color: "#fff"
                    }}
                >
                    {props.loadingContent}
                </div>
            )}

            {props.showRecordingIndicator && isRecording && (
                <div className="camera-recording-indicator">
                    <span className="recording-dot"></span> Recording
                </div>
            )}

            {cameraReady && (
                <Fragment>
                    {props.contentTop && (
                        <div className="camera-content-overlay camera-align-top">{props.contentTop}</div>
                    )}
                    {props.contentMiddle && (
                        <div className="camera-content-overlay camera-align-middle">{props.contentMiddle}</div>
                    )}
                    {props.contentBottom && (
                        <div className="camera-content-overlay camera-align-bottom">{props.contentBottom}</div>
                    )}
                </Fragment>
            )}
        </div>
    );
}
