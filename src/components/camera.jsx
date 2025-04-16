import { createElement, useRef, useEffect, useState, Fragment } from "react";
import Webcam from "react-webcam";
import * as tf from "@tensorflow/tfjs";

export function Camera(props) {
    const webcamRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const [model, setModel] = useState(null);
    const [detections, setDetections] = useState([]);
    const [isDetecting, setIsDetecting] = useState(false);
    const [cameraReady, setCameraReady] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [prevStartRecording, setPrevStartRecording] = useState(false);
    const objectDetectionEnabled = props.objectDetectionEnabled === true;

    useEffect(() => {
        if (!objectDetectionEnabled || !props.modelUrl) return;

        const loadModel = async () => {
            try {
                const loadedModel = await tf.loadGraphModel(props.modelUrl);
                setModel(loadedModel);
                console.log("Object detection model loaded");
            } catch (err) {
                console.error("Failed to load model:", err);
            }
        };
        loadModel();
    }, [objectDetectionEnabled, props.modelUrl]);

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
        setTimeout(() => {
            setCameraReady(true);
            if (objectDetectionEnabled) {
                setIsDetecting(true);
            }
        }, 1000);
    };

    const startRecording = () => {
        if (webcamRef.current && webcamRef.current.stream) {
            const chunks = [];
            const mediaRecorder = new MediaRecorder(webcamRef.current.stream);
            mediaRecorderRef.current = mediaRecorder;
            mediaRecorder.ondataavailable = event => {
                if (event.data.size > 0) {
                    chunks.push(event.data);
                    // If recording has stopped, process the complete video
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
                const base64String = screenshot.split(",")[1]; // Remove the data URL prefix
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
        <div className={"mx-camerastream " + props.classNames} style={{ width: props.width, height: props.height }}>
            <Webcam
                ref={webcamRef}
                screenshotFormat="image/jpeg"
                audio={props.audioEnabled}
                videoConstraints={videoConstraints}
                onUserMedia={handleUserMedia}
            />

            {renderDetections()}

            {!cameraReady && props.loadingContent && <div className="camera-loading">{props.loadingContent}</div>}

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
