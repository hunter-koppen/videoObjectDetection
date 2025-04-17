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
    const [labelMap, setLabelMap] = useState({});
    const [filterIds, setFilterIds] = useState([]);

    useEffect(() => {
        if (!objectDetectionEnabled || !props.modelUrl) return;

        const loadModel = async () => {
            try {
                const loadedModel = await tf.loadGraphModel(props.modelUrl);
                setModel(loadedModel);
                console.log("Using TF backend:", tf.getBackend());
                console.log("Object detection model loaded");
            } catch (err) {
                console.error("Failed to load model:", err);
            }
        };
        loadModel();
    }, [objectDetectionEnabled, props.modelUrl]);

    useEffect(() => {
        if (!objectDetectionEnabled) return;

        // Parse label map
        try {
            const parsedMap = JSON.parse(props.labelMapString || "{}");
            setLabelMap(parsedMap);
        } catch (err) {
            console.error("Failed to parse labelMapString:", err);
            setLabelMap({}); // Default to empty map on error
        }

        // Parse filter IDs
        try {
            const ids = props.filterClassIdsString
                ? props.filterClassIdsString
                      .split(",")
                      .map(id => parseInt(id.trim(), 10))
                      .filter(id => !isNaN(id))
                : [];
            setFilterIds(ids);
        } catch (err) {
            console.error("Failed to parse filterClassIdsString:", err);
            setFilterIds([]); // Default to empty list on error
        }
    }, [objectDetectionEnabled, props.labelMapString, props.filterClassIdsString]);

    useEffect(() => {
        if (!objectDetectionEnabled || !model) return;

        let animationFrameId;
        // --- Frame Skipping ---
        let frameCount = 0;
        const processEveryNFrames = 3; // Adjust this value (e.g., 2, 3) to change detection frequency
        // --- End Frame Skipping ---

        const runDetection = async () => {
            // --- Frame Skipping Check ---
            frameCount++;
            if (frameCount % processEveryNFrames !== 0) {
                // Skip this frame, but request the next one
                if (isDetecting) {
                    // Check if still detecting before requesting next frame
                    animationFrameId = requestAnimationFrame(runDetection);
                }
                return;
            }
            // --- End Frame Skipping Check ---

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
                        const resized = tf.image.resizeBilinear(img, [320, 320]);
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

                        // Create class mask based on filterIds
                        let classMask;
                        if (filterIds.length === 0) {
                            // If no filter IDs provided, allow all classes that pass the score threshold.
                            classMask = tf.fill(classIds.shape, true, "bool");
                        } else {
                            // Compare each detected classId with the allowed filterIds
                            const filterIdsTensor = tf.tensor1d(filterIds, "int32");
                            const comparison = tf.equal(classIds.expandDims(-1), filterIdsTensor.expandDims(0));
                            classMask = tf.any(comparison, -1); // Check if the classId matches *any* of the filterIds
                            tf.dispose([filterIdsTensor, comparison]); // Dispose intermediate tensors
                        }

                        const finalMask = tf.logicalAnd(scoreMask, classMask);
                        tf.dispose([scoreMask, classMask]); // Dispose intermediate masks

                        // 4. Apply Mask using booleanMaskAsync
                        const boxesReshaped = boxesTensorRaw.squeeze();
                        tf.dispose(boxesTensorRaw); // Dispose original raw boxes tensor

                        // Apply mask to boxes, scores, and classIds
                        const finalBoxesTensor = await tf.booleanMaskAsync(boxesReshaped, finalMask);
                        const finalScoresTensor = await tf.booleanMaskAsync(scores, finalMask);
                        const finalClassIdsTensor = await tf.booleanMaskAsync(classIds, finalMask); // Filter classIds as well

                        // Dispose remaining intermediate tensors no longer needed
                        tf.dispose([scores, classIds, finalMask, boxesReshaped]);

                        // 5. Await data from filtered tensors
                        const finalBoxesData = await finalBoxesTensor.data();
                        const finalScoresData = await finalScoresTensor.data();
                        const finalClassIdsData = await finalClassIdsTensor.data(); // Get filtered class IDs

                        // 6. Dispose final tensors
                        tf.dispose([finalBoxesTensor, finalScoresTensor, finalClassIdsTensor]);

                        // 7. Process filtered data
                        for (let i = 0; i < finalScoresData.length; i++) {
                            const score = finalScoresData[i];
                            const classId = finalClassIdsData[i]; // Use the filtered class ID
                            const className = labelMap[classId] || `Class ${classId}`; // Get name from parsed map, provide fallback
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

                    // Request the next frame *after* processing is done (or error caught)
                    if (isDetecting) {
                        animationFrameId = requestAnimationFrame(runDetection);
                    }
                } catch (err) {
                    console.error("Error in runDetection:", err);
                    // Add a delay before retrying after an error
                    setTimeout(() => {
                        if (isDetecting && model) {
                            animationFrameId = requestAnimationFrame(runDetection);
                        }
                    }, 1000);
                }
            } else {
                if (isDetecting) {
                    animationFrameId = requestAnimationFrame(runDetection);
                }
            }
        };

        // Setup detection loop if model is ready and detecting is enabled
        if (isDetecting) {
            frameCount = 0; // Reset frame count when starting
            animationFrameId = requestAnimationFrame(runDetection);
        }

        return () => {
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
            }
        };
    }, [model, isDetecting, filterIds, labelMap]);

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
