import { Fragment, createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Big } from "big.js";
import DetectionWorker from "web-worker:../workers/detection.worker.js";
import Webcam from "react-webcam";

// Utility functions for image quality analysis
const calculateBlurScore = (data, width, height) => {
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

const analyzeImageQuality = imageData => {
    const { data, width, height } = imageData;

    // Calculate blur using Laplacian variance
    const blurScore = calculateBlurScore(data, width, height);

    // Calculate lighting using brightness and contrast
    const lightingScore = calculateLightingScore(data);

    return {
        blurScore: blurScore,
        badLightingScore: lightingScore
    };
};

const calculateMotionScore = (currentData, previousData, width, height) => {
    let motion = 0;
    // Sample pixels for performance
    for (let y = 0; y < height; y += 10) {
        for (let x = 0; x < width; x += 10) {
            const index = (y * width + x) * 4;
            const r1 = currentData[index];
            const g1 = currentData[index + 1];
            const b1 = currentData[index + 2];
            const r2 = previousData[index];
            const g2 = previousData[index + 1];
            const b2 = previousData[index + 2];
            motion += Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
        }
    }
    return motion / (width * height);
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
        blurScore,
        badLightingScore,
        onValidationTick,
        validationInterval = 1000
    } = props;

    const webcamRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const workerRef = useRef(null);
    const animationFrameRef = useRef(null);
    const isWorkerBusy = useRef(false);
    const offscreenCanvasRef = useRef(null);
    const previousFrameDataRef = useRef(null);

    // Refs to hold latest values for the validation timer
    const motionScoreRef = useRef(0);
    const classificationScoreRef = useRef(0);
    const validationTimerRef = useRef(null);

    const [classifications, setClassifications] = useState([]);
    const [isDetecting, setIsDetecting] = useState(false);
    const [cameraReady, setCameraReady] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [prevStartRecording, setPrevStartRecording] = useState(false);
    const objectDetectionEnabled = rawObjectDetectionEnabled === true;

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

        // Create worker only if detection is enabled and model URL is provided
        workerRef.current = new DetectionWorker();

        // Initialize offscreen canvas once
        offscreenCanvasRef.current = document.createElement("canvas");

        // Message handler for worker responses
        workerRef.current.onmessage = event => {
            const { type, payload, message } = event.data;

            switch (type) {
                case "ready":
                    setIsDetecting(true);
                    isWorkerBusy.current = false;
                    break;
                case "classifications":
                    if (payload && payload.length > 0) {
                        // The worker returns the classification for the single prompt.
                        classificationScoreRef.current = payload[0].score;
                    }
                    setClassifications(payload);
                    isWorkerBusy.current = false;
                    break;
                case "error":
                    console.error("Main: Worker error:", message);
                    setIsDetecting(false);
                    isWorkerBusy.current = false;
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

        console.log("Main: Sending load command to worker.");
        workerRef.current.postMessage({
            type: "load",
            payload: {
                modelName: modelName,
                textPrompt: textPrompt
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
    }, [objectDetectionEnabled, modelName, textPrompt]);

    // --- Validation Timer ---
    useEffect(() => {
        if (!isDetecting || !onValidationTick) {
            if (validationTimerRef.current) {
                clearInterval(validationTimerRef.current);
                validationTimerRef.current = null;
            }
            return;
        }

        validationTimerRef.current = setInterval(() => {
            onValidationTick(motionScoreRef.current, classificationScoreRef.current);
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

                // Motion detection
                if (previousFrameDataRef.current) {
                    const motionScore = calculateMotionScore(
                        imageData.data,
                        previousFrameDataRef.current,
                        video.videoWidth,
                        video.videoHeight
                    );
                    motionScoreRef.current = motionScore;
                }
                previousFrameDataRef.current = imageData.data;

                // Send to worker if not busy
                if (!isWorkerBusy.current) {
                    isWorkerBusy.current = true;
                    workerRef.current.postMessage({
                        type: "detect",
                        payload: { imageData: imageData }
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
            previousFrameDataRef.current = null;
        };
    }, [cameraReady, isDetecting]);

    const handleUserMedia = () => {
        // Give webcam time to initialize resolution etc.
        setTimeout(() => {
            setCameraReady(true);
        }, 500);
    };

    // Optional: Display the top classification result
    const renderTopClassification = () => {
        if (!objectDetectionEnabled || !classifications.length) return null;

        const topResult = classifications[0];

        return (
            <div
                style={{
                    position: "absolute",
                    bottom: "20px",
                    left: "50%",
                    transform: "translateX(-50%)",
                    backgroundColor: "rgba(0, 0, 0, 0.6)",
                    color: "white",
                    padding: "8px 15px",
                    borderRadius: "10px",
                    fontSize: "14px",
                    textAlign: "center"
                }}
            >
                {`${topResult.label}: ${Math.round(topResult.score * 100)}%`}
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
                if (blurScore || badLightingScore) {
                    // Analyze image quality
                    const canvas = document.createElement("canvas");
                    const ctx = canvas.getContext("2d");
                    const img = new Image();

                    img.onload = () => {
                        canvas.width = img.width;
                        canvas.height = img.height;
                        ctx.drawImage(img, 0, 0);

                        const imageData = ctx.getImageData(0, 0, img.width, img.height);
                        const quality = analyzeImageQuality(imageData);

                        if (blurScore && blurScore.setValue) {
                            const blurScoreValue = new Big(quality.blurScore.toFixed(0));
                            blurScore.setValue(blurScoreValue);
                        }
                        if (badLightingScore && badLightingScore.setValue) {
                            const badLightingScoreValue = new Big(quality.badLightingScore.toFixed(2));
                            badLightingScore.setValue(badLightingScoreValue);
                        }

                        takeScreenshot.setValue(false);
                        const base64String = screenshot.split(",")[1];
                        onScreenshot(base64String);
                    };

                    img.src = screenshot;
                } else {
                    takeScreenshot.setValue(false);
                    const base64String = screenshot.split(",")[1];
                    onScreenshot(base64String);
                }
            }
        }
    }, [takeScreenshot, onScreenshot, blurScore, badLightingScore]);

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

    const videoConstraints = useMemo(() => {
        const constraints = {
            facingMode: props.facingMode || "environment"
        };
        if (props.torchEnabled === true) {
            constraints.advanced = [{ torch: true }];
        }
        return constraints;
    }, [props.facingMode, props.torchEnabled]);

    useEffect(() => {
        if (!webcamRef.current || !webcamRef.current.stream) {
            return;
        }
        const videoTrack = webcamRef.current.stream.getVideoTracks()[0];
        if (!videoTrack) {
            return;
        }
        if (props.torchEnabled === true) {
            videoTrack
                .applyConstraints({
                    advanced: [{ torch: true }]
                })
                .catch(error => {
                    console.error("Failed to apply torch setting:", error);
                });
        } else {
            videoTrack
                .applyConstraints({
                    advanced: [{ torch: false }]
                })
                .catch(error => {
                    console.error("Failed to apply torch setting:", error);
                });
        }
    }, [props.torchEnabled]);

    return (
        <div
            className={"mx-camerastream " + props.classNames}
            style={{ position: "relative", width: props.width, height: props.height }}
        >
            <Webcam
                ref={webcamRef}
                screenshotFormat="image/jpeg"
                audio={props.audioEnabled}
                videoConstraints={videoConstraints}
                onUserMedia={handleUserMedia}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />

            {props.showTopClassification && renderTopClassification()}

            {(!cameraReady || !isDetecting) && props.loadingContent && objectDetectionEnabled && (
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
                        backgroundColor: "rgba(0,0,0,0.5)"
                    }}
                >
                    {props.loadingContent}
                </div>
            )}
            {!objectDetectionEnabled && !cameraReady && props.loadingContent && (
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
                        backgroundColor: "rgba(0,0,0,0.5)"
                    }}
                >
                    {props.loadingContent}
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
