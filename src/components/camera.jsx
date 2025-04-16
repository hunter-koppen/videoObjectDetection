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
        if (!objectDetectionEnabled || !model) return;

        let animationFrameId;

        const runDetection = async () => {
            if (model && webcamRef.current && webcamRef.current.video && isDetecting) {
                const video = webcamRef.current.video;
                if (video.readyState !== 4 || !video.videoWidth || !video.videoHeight) {
                    animationFrameId = requestAnimationFrame(runDetection);
                    return;
                }
                try {
                    const videoWidth = video.videoWidth;
                    const videoHeight = video.videoHeight;

                    // Preprocess the video frame
                    const tensor = tf.tidy(() => {
                        const img = tf.browser.fromPixels(video);
                        // Resize the image to the expected input size (640x640) change this to match the model input size
                        const resized = tf.image.resizeBilinear(img, [640, 640]);
                        const casted = resized.cast("int32"); // Cast after resizing
                        const expanded = casted.expandDims(0);
                        return expanded;
                    });

                    // Execute the model - Request ALL output tensors from signature
                    const outputNodeNames = [
                        // Only request the tensors we now know we need
                        "Identity_1:0", // Boxes (Index 0 in new map)
                        "Identity_5:0", // Num Detections (Index 1 in new map)
                        "Identity_4:0", // Scores (Index 2 in new map)
                        "Identity_3:0" // Class Specific Scores [1, 100, 2] (Index 3 in new map)
                    ];
                    const outputTensors = await model.executeAsync(tensor, outputNodeNames);
                    const [boxesTensorRaw, numDetectionsTensor, scoresTensorRaw, classesInfoTensorRaw] = outputTensors;

                    const numDetections = (await numDetectionsTensor.data())[0];
                    tf.dispose(numDetectionsTensor);

                    let newDetections = [];

                    if (numDetections > 0) {
                        // --- Manual Tensor Operations and Disposal ---

                        // 1. Get Scores & Dispose Original Raw
                        const scores = scoresTensorRaw.squeeze();
                        tf.dispose(scoresTensorRaw);

                        // 2. Derive Class IDs & Dispose Original Raw
                        const classIds = tf.argMax(classesInfoTensorRaw, -1).squeeze();
                        tf.dispose(classesInfoTensorRaw);

                        // 3. Create Masks
                        const scoreThreshold = 0.5;
                        const scoreMask = tf.greaterEqual(scores, scoreThreshold);
                        const classMask = tf.equal(classIds, 1);
                        const finalMask = tf.logicalAnd(scoreMask, classMask);
                        tf.dispose([scoreMask, classMask]); // Dispose intermediate masks

                        // 4. Apply Mask using booleanMaskAsync
                        const boxesReshaped = boxesTensorRaw.squeeze();
                        tf.dispose(boxesTensorRaw);

                        const finalBoxesTensor = await tf.booleanMaskAsync(boxesReshaped, finalMask);
                        const finalScoresTensor = await tf.booleanMaskAsync(scores, finalMask);

                        // Dispose remaining intermediate tensors
                        tf.dispose([scores, classIds, finalMask, boxesReshaped]);

                        // 5. Await data
                        const finalBoxesData = await finalBoxesTensor.data();
                        const finalScoresData = await finalScoresTensor.data();

                        // 6. Dispose final tensors
                        tf.dispose([finalBoxesTensor, finalScoresTensor]);

                        // 7. Process filtered data
                        const labelMap = { 1: "Energiemeter" }; // change this to match the model output
                        for (let i = 0; i < finalScoresData.length; i++) {
                            const score = finalScoresData[i];
                            const className = labelMap[1];
                            const [ymin, xmin, ymax, xmax] = finalBoxesData.slice(i * 4, (i + 1) * 4);
                            const bboxLeft = xmin * videoWidth;
                            const bboxTop = ymin * videoHeight;
                            const bboxWidth = (xmax - xmin) * videoWidth;
                            const bboxHeight = (ymax - ymin) * videoHeight;
                            newDetections.push({
                                class: className,
                                score: score,
                                bbox: [bboxLeft, bboxTop, bboxWidth, bboxHeight]
                            });
                        }
                    } else {
                        // Dispose raw tensors if no detections
                        tf.dispose([boxesTensorRaw, scoresTensorRaw, classesInfoTensorRaw]);
                    }

                    // Dispose input tensor
                    tf.dispose(tensor);

                    setDetections(newDetections);

                    animationFrameId = requestAnimationFrame(runDetection);
                } catch (err) {
                    console.error("Error in runDetection:", err);
                    // Add a delay before retrying after an error
                    setTimeout(() => {
                        if (isDetecting && model) {
                            // Check again if still should be running
                            animationFrameId = requestAnimationFrame(runDetection);
                        }
                    }, 1000);
                }
            } else {
                // If condition is false, schedule the next check if still detecting
                if (isDetecting) {
                    animationFrameId = requestAnimationFrame(runDetection);
                }
            }
        };

        // Setup detection loop if model is ready and detecting is enabled
        // This initial call is important
        if (isDetecting) {
            animationFrameId = requestAnimationFrame(runDetection);
        }

        return () => {
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
            }
        };
    }, [model, isDetecting]); // Rerun effect if model or isDetecting changes

    const handleUserMedia = () => {
        setTimeout(() => {
            setCameraReady(true);
            if (objectDetectionEnabled) {
                setIsDetecting(true);
            }
        }, 1000);
    };

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

            {!cameraReady && props.loadingContent && (
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
