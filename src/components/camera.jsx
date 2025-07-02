import { Fragment, createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Big } from "big.js";
import DetectionWorker from "web-worker:../workers/detection.worker.js";
import Webcam from "react-webcam";

// Utility functions for image quality analysis
const calculateSharpnessScore = (data, width, height) => {
    let variance = 0;
    let count = 0;

    // Sample pixels for performance (every 4th pixel)
    for (let y = 1; y < height - 1; y += 4) {
        for (let x = 1; x < width - 1; x += 4) {
            const idx = (y * width + x) * 4;

            // Get surrounding pixels
            const current = data[idx];
            const left = data[idx - 4];
            const right = data[idx + 4];
            const top = data[idx - width * 4];
            const bottom = data[idx + width * 4];

            // Laplacian filter approximation
            const laplacian = Math.abs(4 * current - left - right - top - bottom);
            variance += laplacian * laplacian;
            count++;
        }
    }

    return count > 0 ? variance / count : 0;
};

const calculateLightingScore = data => {
    let totalBrightness = 0;
    let totalPixels = 0;

    // Sample pixels for performance (every 4th pixel)
    for (let i = 0; i < data.length; i += 16) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // Calculate brightness (weighted average of RGB)
        const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        totalBrightness += brightness;
        totalPixels++;
    }

    return totalPixels > 0 ? totalBrightness / totalPixels : 0;
};

// iOS Chromium detection utility
const isIOSChromium = () => {
    const userAgent = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(userAgent));

    if (!isIOS) return false;

    // Check if it's a Chromium-based browser (Chrome) but not Safari
    const isChromium = /Chrome|CriOS/.test(userAgent);
    const isSafari = /Safari/.test(userAgent) && !/Chrome|CriOS/.test(userAgent);

    return isChromium && !isSafari;
};

export function Camera(props) {
    const {
        takeScreenshot,
        onScreenshot,
        startRecording: startRecordingProp,
        onRecordingComplete,
        objectDetectionEnabled: rawObjectDetectionEnabled,
        modelName,
        textPrompt,
        negativeTextPrompt,
        onValidationTick,
        validationInterval,
        showClassificationResults,
        userGestureButtonText
    } = props;

    const webcamRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const workerRef = useRef(null);
    const animationFrameRef = useRef(null);
    const isWorkerBusy = useRef(false);
    const offscreenCanvasRef = useRef(null);

    // Refs to hold latest values for the validation timer
    const classificationScoreRef = useRef(0);
    const lightingScoreRef = useRef(0);
    const sharpnessScoreRef = useRef(0);
    const validationTimerRef = useRef(null);
    const textPromptRef = useRef(textPrompt);

    const [classifications, setClassifications] = useState([]);
    const [isDetecting, setIsDetecting] = useState(false);
    const [cameraReady, setCameraReady] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [prevStartRecording, setPrevStartRecording] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState(null);
    const [needsUserGesture, setNeedsUserGesture] = useState(false);
    const [userGestureProvided, setUserGestureProvided] = useState(false);
    const [webcamKey, setWebcamKey] = useState(0);
    const objectDetectionEnabled = rawObjectDetectionEnabled === true;

    // Check if we need user gesture on mount (iOS Chromium browsers only)
    useEffect(() => {
        if (isIOSChromium()) {
            setNeedsUserGesture(true);
        }
    }, []);

    // Handle user gesture to start camera
    const handleUserGesture = useCallback(() => {
        console.log("User gesture provided, restarting webcam...");
        setUserGestureProvided(true);
        setNeedsUserGesture(false);

        // Force webcam to restart with autoPlay enabled
        setWebcamKey(prev => prev + 1);

        // Give webcam time to initialize after user gesture
        setTimeout(() => {
            console.log("Setting camera ready after user gesture");
            setCameraReady(true);
        }, 500);
    }, []);

    // --- Worker Setup ---
    useEffect(() => {
        if (!objectDetectionEnabled || !modelName) {
            // If detection is disabled or no model URL, ensure worker is terminated if it exists
            if (workerRef.current) {
                console.log("Main: Terminating worker due to props change.");
                workerRef.current.terminate();
                workerRef.current = null;
                setIsDetecting(false); // Ensure detection state is off
            }
            return () => {
                // No cleanup needed for early return
            };
        }

        workerRef.current = new DetectionWorker();

        // Initialize offscreen canvas once
        offscreenCanvasRef.current = document.createElement("canvas");

        // Message handler for worker responses
        workerRef.current.onmessage = event => {
            const { type, payload, message } = event.data;

            switch (type) {
                case "loading":
                    setLoadingMessage(message);
                    break;
                case "ready":
                    setLoadingMessage(null);
                    setIsDetecting(true);
                    isWorkerBusy.current = false;
                    break;
                case "classifications":
                    if (payload && payload.length > 0) {
                        // The worker now returns all classifications, use the main prompt score
                        const mainClassification = payload.find(result => result.label === textPromptRef.current);
                        classificationScoreRef.current = mainClassification ? mainClassification.score : 0;
                    }
                    setClassifications(payload);
                    isWorkerBusy.current = false;
                    break;
                case "error":
                    console.error("Main: Worker error:", message);
                    setIsDetecting(false);
                    isWorkerBusy.current = false;
                    setLoadingMessage("Error: " + message); // Display error to user
                    break;
                default:
                    console.warn("Main: Unknown message type from worker:", type);
            }
        };

        // Error handler for worker initialization errors
        workerRef.current.onerror = error => {
            console.error("Main: Worker initialization failed:", error);
            setIsDetecting(false);
        };

        workerRef.current.postMessage({
            type: "load",
            payload: {
                modelName: modelName,
                textPrompt: textPrompt,
                negativeTextPrompt: negativeTextPrompt
            }
        });

        // --- Cleanup function ---
        return () => {
            if (workerRef.current) {
                workerRef.current.terminate();
                workerRef.current = null;
            }
            setIsDetecting(false);
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
                animationFrameRef.current = null;
            }
        };
    }, [objectDetectionEnabled, modelName]); // Only recreate worker when model changes, dont add textPrompt and negativeTextPrompt to the dependency array

    // --- Prompt Updates ---
    useEffect(() => {
        // Update the ref to latest textPrompt value
        textPromptRef.current = textPrompt;

        // Send prompt updates to existing worker without recreating it
        if (workerRef.current && objectDetectionEnabled && modelName) {
            workerRef.current.postMessage({
                type: "load",
                payload: {
                    modelName: modelName,
                    textPrompt: textPrompt,
                    negativeTextPrompt: negativeTextPrompt
                }
            });
        }
    }, [textPrompt, negativeTextPrompt]); // Only when prompts change, dont add workerRef.current to the dependency array

    // --- Validation Timer ---
    useEffect(() => {
        if (!isDetecting || !onValidationTick) {
            if (validationTimerRef.current) {
                clearInterval(validationTimerRef.current);
                validationTimerRef.current = null;
            }
            return () => {};
        }

        validationTimerRef.current = setInterval(() => {
            onValidationTick(classificationScoreRef.current, lightingScoreRef.current, sharpnessScoreRef.current);
        }, validationInterval);

        return () => {
            if (validationTimerRef.current) {
                clearInterval(validationTimerRef.current);
                validationTimerRef.current = null;
            }
        };
    }, [isDetecting, onValidationTick, validationInterval]);

    // --- Frame Capture and Sending Loop ---
    useEffect(() => {
        const captureLoop = () => {
            // Stop loop if detection isn't active or worker isn't ready/initialized
            if (!isDetecting || !workerRef.current || !webcamRef.current || !webcamRef.current.video) {
                animationFrameRef.current = requestAnimationFrame(captureLoop); // Keep checking
                return;
            }

            const video = webcamRef.current.video;

            // Check if video is ready and worker is not busy
            if (video.readyState === 4 && video.videoWidth > 0 && video.videoHeight > 0) {
                const canvas = offscreenCanvasRef.current;
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext("2d", { willReadFrequently: true });

                if (!ctx) {
                    animationFrameRef.current = requestAnimationFrame(captureLoop);
                    return;
                }

                ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
                const imageData = ctx.getImageData(0, 0, video.videoWidth, video.videoHeight);

                const sharpness = calculateSharpnessScore(imageData.data, video.videoWidth, video.videoHeight);
                sharpnessScoreRef.current = sharpness;

                const lightingScore = calculateLightingScore(imageData.data);
                lightingScoreRef.current = lightingScore;

                // Send to worker if not busy
                if (!isWorkerBusy.current) {
                    isWorkerBusy.current = true;

                    // Convert canvas to data URL (most compatible with Transformers.js)
                    const dataURL = canvas.toDataURL("image/jpeg", 0.95);
                    console.log("Main: Created dataURL, length:", dataURL.length);
                    workerRef.current.postMessage({
                        type: "detect",
                        payload: { imageDataURL: dataURL }
                    });
                }
            }

            // Request the next frame
            animationFrameRef.current = requestAnimationFrame(captureLoop);
        };

        // Start the loop only when the camera and worker are ready
        if (cameraReady && isDetecting) {
            console.log("Main: Starting capture loop.");
            isWorkerBusy.current = false; // Ensure flag is reset when starting
            animationFrameRef.current = requestAnimationFrame(captureLoop);
        } else {
            // If conditions aren't met, ensure any existing loop is stopped.
            if (animationFrameRef.current) {
                console.log("Main: Stopping capture loop (camera/worker not ready).");
                cancelAnimationFrame(animationFrameRef.current);
                animationFrameRef.current = null;
            }
        }

        // Cleanup function for the loop effect
        return () => {
            if (animationFrameRef.current) {
                console.log("Main: Stopping capture loop on effect cleanup.");
                cancelAnimationFrame(animationFrameRef.current);
                animationFrameRef.current = null;
            }
        };
    }, [cameraReady, isDetecting]);

    const handleUserMedia = () => {
        console.log(
            "handleUserMedia called, needsUserGesture:",
            needsUserGesture,
            "userGestureProvided:",
            userGestureProvided
        );
        // Only auto-start camera if user gesture is not required or has been provided
        if (!needsUserGesture || userGestureProvided) {
            console.log("Setting camera ready in handleUserMedia");
            // Give webcam time to initialize resolution etc.
            setTimeout(() => {
                setCameraReady(true);
            }, 500);
        }
    };

    // Optional: Display all classification results
    const renderClassificationResults = () => {
        if (!objectDetectionEnabled || !classifications.length || !showClassificationResults) return null;

        return (
            <div
                style={{
                    position: "absolute",
                    top: "20px",
                    left: "50%",
                    transform: "translateX(-50%)",
                    backgroundColor: "rgba(0, 0, 0, 0.6)",
                    color: "white",
                    padding: "8px 15px",
                    borderRadius: "10px",
                    fontSize: "14px",
                    textAlign: "center",
                    maxHeight: "200px",
                    overflowY: "auto"
                }}
            >
                {classifications.map((result, index) => (
                    <div key={index} style={{ marginBottom: index < classifications.length - 1 ? "4px" : "0" }}>
                        {`${result.label}: ${Math.round(result.score * 100)}%`}
                    </div>
                ))}
            </div>
        );
    };

    const startRecording = useCallback(() => {
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
                            if (onRecordingComplete) {
                                onRecordingComplete(base64String);
                            }
                        };
                        setIsRecording(false);
                    }
                }
            };
            mediaRecorder.start();
            setIsRecording(true);
        }
    }, [onRecordingComplete]); // webcamRef, mediaRecorderRef are refs, setIsRecording is stable

    const stopRecording = useCallback(() => {
        if (mediaRecorderRef.current) {
            mediaRecorderRef.current.stop();
        }
    }, []); // mediaRecorderRef is a ref

    useEffect(() => {
        if (takeScreenshot && takeScreenshot.value === true && webcamRef.current) {
            const screenshot = webcamRef.current.getScreenshot();
            if (onScreenshot && screenshot) {
                takeScreenshot.setValue(false);
                const base64String = screenshot.split(",")[1];
                onScreenshot(base64String);
            }
        }
    }, [takeScreenshot, onScreenshot]);

    useEffect(() => {
        if (!startRecordingProp) {
            return;
        }
        if (startRecordingProp.value === true && !prevStartRecording) {
            startRecording();
        } else if (startRecordingProp.value === false && prevStartRecording) {
            stopRecording();
        }
        setPrevStartRecording(startRecordingProp.value);
    }, [startRecordingProp, prevStartRecording, startRecording, stopRecording]);

    const videoConstraints = useMemo(
        () => ({
            facingMode: props.facingMode || "environment"
        }),
        [props.facingMode]
    );

    useEffect(() => {
        if (!cameraReady || !webcamRef.current || !webcamRef.current.stream) {
            return;
        }
        const videoTrack = webcamRef.current.stream.getVideoTracks()[0];
        if (!videoTrack) {
            return;
        }

        // Check if torch capability is supported by the browser/device
        const capabilities = videoTrack.getCapabilities();
        if (capabilities.torch) {
            videoTrack
                .applyConstraints({
                    advanced: [{ torch: !!props.torchEnabled }]
                })
                .catch(error => {
                    console.error("Failed to apply torch setting:", error);
                });
        }
    }, [props.torchEnabled, cameraReady]);

    return (
        <div
            className={"mx-camerastream " + props.classNames}
            style={{ position: "relative", width: props.width, height: props.height }}
        >
            <Webcam
                key={webcamKey}
                ref={webcamRef}
                screenshotFormat="image/jpeg"
                audio={props.audioEnabled}
                videoConstraints={videoConstraints}
                onUserMedia={handleUserMedia}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
                playsInline={true}
                muted={true}
                autoPlay={!needsUserGesture}
            />

            {props.showClassificationResults && renderClassificationResults()}

            {needsUserGesture && (
                <div
                    className="camera-user-gesture-overlay"
                    style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: "100%",
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "center",
                        alignItems: "center",
                        backgroundColor: "black",
                        color: "white",
                        textAlign: "center",
                        zIndex: 1000
                    }}
                    onClick={handleUserGesture}
                >
                    <div style={{ fontSize: "18px", marginBottom: "20px" }}>{userGestureButtonText}</div>
                </div>
            )}

            {(loadingMessage || (!cameraReady && objectDetectionEnabled && !needsUserGesture)) && (
                <div
                    className="camera-loading"
                    style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: "100%",
                        display: "flex",
                        justifyContent: "center",
                        alignItems: "center",
                        backgroundColor: "rgba(0,0,0,0.5)",
                        color: "white",
                        textAlign: "center"
                    }}
                >
                    {loadingMessage || "Starting camera..."}
                </div>
            )}

            {props.showRecordingIndicator && isRecording && (
                <div
                    className="camera-recording-indicator"
                    style={{
                        position: "absolute",
                        top: "10px",
                        left: "10px",
                        background: "rgba(255, 0, 0, 0.7)",
                        color: "white",
                        padding: "5px 10px",
                        borderRadius: "5px",
                        display: "flex",
                        alignItems: "center"
                    }}
                >
                    <span
                        className="recording-dot"
                        style={{
                            height: "10px",
                            width: "10px",
                            backgroundColor: "red",
                            borderRadius: "50%",
                            display: "inline-block",
                            marginRight: "5px"
                        }}
                    ></span>{" "}
                    Recording
                </div>
            )}

            {cameraReady && (
                <Fragment>
                    {props.contentTop && (
                        <div
                            className="camera-content-overlay camera-align-top"
                            style={{ position: "absolute", top: 0, left: 0, width: "100%", pointerEvents: "none" }}
                        >
                            {props.contentTop}
                        </div>
                    )}
                    {props.contentMiddle && (
                        <div
                            className="camera-content-overlay camera-align-middle"
                            style={{
                                position: "absolute",
                                top: "50%",
                                left: "50%",
                                transform: "translate(-50%, -50%)",
                                pointerEvents: "none"
                            }}
                        >
                            {props.contentMiddle}
                        </div>
                    )}
                    {props.contentBottom && (
                        <div
                            className="camera-content-overlay camera-align-bottom"
                            style={{ position: "absolute", bottom: 0, left: 0, width: "100%", pointerEvents: "none" }}
                        >
                            {props.contentBottom}
                        </div>
                    )}
                </Fragment>
            )}
        </div>
    );
}
