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

export function Camera(props) {
    const {
        takeScreenshot,
        onScreenshot,
        startRecording: startRecordingProp,
        onRecordingComplete,
        objectDetectionEnabled: rawObjectDetectionEnabled,
        modelUrl,
        labelMapString,
        filterClassIdsString,
        blurScore,
        badLightingScore
    } = props;

    const webcamRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const workerRef = useRef(null); // Ref to hold the worker instance
    const animationFrameRef = useRef(null); // Ref for the animation frame loop
    const isWorkerBusy = useRef(false); // Ref to track if worker is processing
    const offscreenCanvasRef = useRef(null); // For drawing video frame to get ImageData

    const [detections, setDetections] = useState([]);
    const [isDetecting, setIsDetecting] = useState(false); // Controlled by worker readiness and props
    const [cameraReady, setCameraReady] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [prevStartRecording, setPrevStartRecording] = useState(false);
    const objectDetectionEnabled = rawObjectDetectionEnabled === true;

    // --- Worker Setup ---
    useEffect(() => {
        if (!objectDetectionEnabled || !modelUrl) {
            // If detection is disabled or no model URL, ensure worker is terminated if it exists
            if (workerRef.current) {
                console.log("Main: Terminating worker due to props change.");
                workerRef.current.terminate();
                workerRef.current = null;
                setIsDetecting(false); // Ensure detection state is off
            }
            return () => {}; // Return a no-op cleanup function for consistency
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
                case "detections":
                    setDetections(payload);
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

        // Parse label map and filter IDs here before sending to worker
        let labelMap = {};
        let filterIds = [];
        try {
            labelMap = JSON.parse(labelMapString || "{}");
        } catch (err) {
            console.error("Failed to parse labelMapString:", err);
        }
        try {
            filterIds = filterClassIdsString
                ? filterClassIdsString
                      .split(",")
                      .map(id => parseInt(id.trim(), 10))
                      .filter(id => !isNaN(id))
                : [];
        } catch (err) {
            console.error("Failed to parse filterClassIdsString:", err);
        }

        console.log("Main: Sending load command to worker.");
        workerRef.current.postMessage({
            type: "load",
            payload: {
                modelUrl: modelUrl,
                labelMap: labelMap,
                filterIds: filterIds,
                scoreThreshold: props.scoreThreshold || 0.5
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
    }, [objectDetectionEnabled, modelUrl, labelMapString, filterClassIdsString, props.scoreThreshold]); // Rerun if these change

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
            if (video.readyState === 4 && video.videoWidth > 0 && video.videoHeight > 0 && !isWorkerBusy.current) {
                // console.time("Frame Capture & Send"); // Optional timing

                // Set worker as busy
                isWorkerBusy.current = true;

                // Draw video frame to the offscreen canvas
                const canvas = offscreenCanvasRef.current;
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext("2d", { willReadFrequently: true }); // Optimize for frequent reads

                if (ctx) {
                    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
                    // Get ImageData from the canvas
                    const imageData = ctx.getImageData(0, 0, video.videoWidth, video.videoHeight);

                    // Send ImageData to the worker
                    // Note: ImageData is NOT Transferable, it will be copied (structured clone algorithm)
                    // For potential optimization, investigate OffscreenCanvas and transferControlToOffscreen()
                    // or createImageBitmap() if the worker can handle ImageBitmap input.
                    workerRef.current.postMessage({
                        type: "detect",
                        payload: {
                            imageData: imageData,
                            width: video.videoWidth,
                            height: video.videoHeight
                        }
                    });
                    // console.timeEnd("Frame Capture & Send"); // Optional timing
                } else {
                    console.error("Main: Could not get 2D context from offscreen canvas.");
                    isWorkerBusy.current = false; // Reset busy flag if context fails
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
    }, [cameraReady, isDetecting]); // Rerun this effect if cameraReady or isDetecting changes

    const handleUserMedia = () => {
        // Give webcam time to initialize resolution etc.
        setTimeout(() => {
            setCameraReady(true);
        }, 1000);
    };

    // renderDetections remains the same, it just consumes the 'detections' state
    const renderDetections = () => {
        if (!objectDetectionEnabled || !detections.length) return null;

        return (
            <div
                style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}
            >
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

            {props.showBoundingBoxes && renderDetections()}

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
