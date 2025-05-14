import { createElement, useRef, useEffect, useState, Fragment } from "react";
import Webcam from "react-webcam";
// Remove direct tfjs import if not needed elsewhere in this component
// import * as tf from "@tensorflow/tfjs";
import DetectionWorker from "web-worker:../workers/detection.worker.js"; // Use web-worker: prefix

export function Camera(props) {
    const webcamRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const workerRef = useRef(null); // Ref to hold the worker instance
    const animationFrameRef = useRef(null); // Ref for the animation frame loop
    const isWorkerBusy = useRef(false); // Ref to track if worker is processing
    const offscreenCanvasRef = useRef(null); // For drawing video frame to get ImageData

    // Remove model state, use worker readiness instead if needed
    // const [model, setModel] = useState(null);
    const [detections, setDetections] = useState([]);
    const [isDetecting, setIsDetecting] = useState(false); // Controlled by worker readiness and props
    const [cameraReady, setCameraReady] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [prevStartRecording, setPrevStartRecording] = useState(false);
    const objectDetectionEnabled = props.objectDetectionEnabled === true;

    // Label map and filter IDs will be sent to the worker, no need for state here unless needed for display elsewhere
    // const [labelMap, setLabelMap] = useState({});
    // const [filterIds, setFilterIds] = useState([]);


    // --- Worker Setup Effect ---
    useEffect(() => {
        if (!objectDetectionEnabled || !props.modelUrl) {
            // If detection is disabled or no model URL, ensure worker is terminated if it exists
            if (workerRef.current) {
                console.log("Main: Terminating worker due to props change.");
                workerRef.current.terminate();
                workerRef.current = null;
                setIsDetecting(false); // Ensure detection state is off
            }
            return;
        }

        // Create worker only if detection is enabled and model URL is provided
        console.log("Main: Initializing worker...");
        // Ensure the path is correct relative to your project setup/bundler output
        // For Create React App, you might need to configure worker-loader or use public folder
        // The new path assumes the worker is in a 'public' folder and served at the root.
        // workerRef.current = new Worker('/detection.worker.js', { type: 'module' }); // Old way
        workerRef.current = new DetectionWorker(); // New way with loader

        // Initialize offscreen canvas once
        offscreenCanvasRef.current = document.createElement('canvas');


        // Message handler for worker responses
        workerRef.current.onmessage = (event) => {
            const { type, payload, message } = event.data;
            // console.log("Main: Received message from worker:", type); // Optional: log messages

            switch (type) {
                case 'ready':
                    console.log("Main: Worker reported model ready.");
                    setIsDetecting(true); // Worker is ready, start detection loop if camera is also ready
                    isWorkerBusy.current = false; // Ensure busy flag is reset
                    break;
                case 'detections':
                    setDetections(payload);
                    isWorkerBusy.current = false; // Worker finished, ready for next frame
                    break;
                case 'error':
                    console.error("Main: Worker error:", message);
                    setIsDetecting(false); // Stop detection on worker error
                    isWorkerBusy.current = false; // Reset busy flag
                    // Optionally, add state to show an error message to the user
                    break;
                default:
                    console.warn("Main: Unknown message type from worker:", type);
            }
        };

        // Error handler for worker initialization errors
        workerRef.current.onerror = (error) => {
            console.error("Main: Worker initialization failed:", error);
            setIsDetecting(false);
            // Optionally, add state to show an error message to the user
        };

        // --- Load model in worker ---
        // Parse label map and filter IDs here before sending to worker
        let labelMap = {};
        let filterIds = [];
        try {
             labelMap = JSON.parse(props.labelMapString || "{}");
        } catch (err) {
             console.error("Failed to parse labelMapString:", err);
        }
        try {
            filterIds = props.filterClassIdsString
                 ? props.filterClassIdsString
                       .split(",")
                       .map(id => parseInt(id.trim(), 10))
                       .filter(id => !isNaN(id))
                 : [];
        } catch (err) {
            console.error("Failed to parse filterClassIdsString:", err);
        }

        console.log("Main: Sending load command to worker.");
        workerRef.current.postMessage({
            type: 'load',
            payload: {
                modelUrl: props.modelUrl,
                labelMap: labelMap,
                filterIds: filterIds
            }
        });


        // --- Cleanup function ---
        return () => {
            console.log("Main: Terminating worker on component unmount or props change.");
            if (workerRef.current) {
                workerRef.current.terminate();
                workerRef.current = null;
            }
            setIsDetecting(false); // Ensure detection state is off
             if (animationFrameRef.current) { // Cancel animation frame on cleanup
                 cancelAnimationFrame(animationFrameRef.current);
                 animationFrameRef.current = null;
             }
        };
    }, [objectDetectionEnabled, props.modelUrl, props.labelMapString, props.filterClassIdsString]); // Rerun if these change


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
                const ctx = canvas.getContext('2d', { willReadFrequently: true }); // Optimize for frequent reads

                if (ctx) {
                    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
                    // Get ImageData from the canvas
                    const imageData = ctx.getImageData(0, 0, video.videoWidth, video.videoHeight);

                    // Send ImageData to the worker
                    // Note: ImageData is NOT Transferable, it will be copied (structured clone algorithm)
                    // For potential optimization, investigate OffscreenCanvas and transferControlToOffscreen()
                    // or createImageBitmap() if the worker can handle ImageBitmap input.
                    workerRef.current.postMessage({
                        type: 'detect',
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

            } else {
                 // Optional: Log why a frame was skipped
                 // if (video.readyState !== 4) console.log("Skip: Video not ready");
                 // else if (isWorkerBusy.current) console.log("Skip: Worker busy");
                 // else if (!video.videoWidth || !video.videoHeight) console.log("Skip: Video dimensions 0");
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


    // --- Remove the old detection useEffect ---
    /*
    useEffect(() => {
        // ... old runDetection logic ...
    }, [model, isDetecting, filterIds, labelMap]);
    */

    const handleUserMedia = () => {
        // Give webcam time to initialize resolution etc.
        setTimeout(() => {
            console.log("Main: Camera ready.");
            setCameraReady(true);
            // Detection (isDetecting state) will be triggered by worker readiness now
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

            {renderDetections()}

            {/* Show loading until camera is ready AND worker is ready (isDetecting is true) */}
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
                    {/* Modify loading content maybe? */}
                    {props.loadingContent}
                    {!cameraReady && <span> Waiting for camera...</span>}
                    {cameraReady && !isDetecting && <span> Loading model...</span>}
                </div>
            )}
             {/* Keep original loading for non-detection case */}
             {!objectDetectionEnabled && !cameraReady && props.loadingContent && (
                 <div className="camera-loading" style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", display: "flex", justifyContent: "center", alignItems: "center", backgroundColor: "rgba(0,0,0,0.5)" }}>
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
