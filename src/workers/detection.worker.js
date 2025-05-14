import * as tf from "@tensorflow/tfjs";

let model = null;
let labelMap = {};
let filterIds = [];
let isReady = false;

async function loadModel(modelUrl) {
    if (model) {
        console.log("Worker: Model already loaded.");
        return true;
    }
    try {
        console.log("Worker: Setting backend...");
        await tf.setBackend("webgl"); // Or 'wasm' as fallback if needed
        console.log("Worker: Using TF backend:", tf.getBackend());
        console.log("Worker: Loading model from", modelUrl);
        model = await tf.loadGraphModel(modelUrl);
        console.log("Worker: Model loaded successfully.");
        isReady = true;
        self.postMessage({ type: "ready" });
        return true;
    } catch (error) {
        console.error("Worker: Failed to load model or set backend", error);
        self.postMessage({ type: "error", message: `Failed to load model: ${error.message}` });
        return false;
    }
}

async function runDetection(imageData, videoWidth, videoHeight) {
    if (!model || !isReady) {
        console.warn("Worker: Model not loaded or not ready yet.");
        return [];
    }

    let tensor;
    let outputTensors;
    let boxesTensorRaw;
    let numDetectionsTensor;
    let scoresTensorRaw;
    let classesInfoTensorRaw;

    // console.time("Worker: Detection Cycle"); // Optional: timing inside worker
    try {
        // console.time("Worker: Preprocess");
        tensor = tf.tidy(() => {
            // Use tf.browser.fromPixels with ImageData
            const img = tf.browser.fromPixels(imageData);
            // Ensure resizing matches the model input (adjust if different)
            const resized = tf.image.resizeBilinear(img, [320, 320]);
            const casted = resized.cast("int32");
            const expanded = casted.expandDims(0);
            return expanded;
        });
        // console.timeEnd("Worker: Preprocess");

        // console.time("Worker: Execute");
        const outputNodeNames = [
            "Identity_1:0", // Boxes
            "Identity_5:0", // Num Detections
            "Identity_4:0", // Scores
            "Identity_3:0" // Class Scores (adjust names if model signature differs)
        ];
        outputTensors = await model.executeAsync(tensor, outputNodeNames);
        // console.timeEnd("Worker: Execute");

        // console.time("Worker: Postprocess");
        [boxesTensorRaw, numDetectionsTensor, scoresTensorRaw, classesInfoTensorRaw] = outputTensors;

        const numDetections = (await numDetectionsTensor.data())[0];
        tf.dispose(numDetectionsTensor);

        const detections = [];

        if (numDetections > 0 && boxesTensorRaw && scoresTensorRaw && classesInfoTensorRaw) {
            // Use .data() for asynchronous data retrieval
            const scoresData = await scoresTensorRaw.squeeze().data();
            tf.dispose(scoresTensorRaw);

            // Derive class IDs (async example)
            const classIdsData = await tf.argMax(classesInfoTensorRaw, -1).squeeze().data();
            tf.dispose(classesInfoTensorRaw);

            const boxesData = await boxesTensorRaw.squeeze().data();
            tf.dispose(boxesTensorRaw);

            const scoreThreshold = 0.5; // Consider making this configurable via message

            for (let i = 0; i < numDetections; i++) {
                const score = scoresData[i];
                const classId = classIdsData[i];

                if (score >= scoreThreshold) {
                    // Apply class filtering
                    if (filterIds.length === 0 || filterIds.includes(classId)) {
                        const className = labelMap[classId] || `Class ${classId}`;
                        const [ymin, xmin, ymax, xmax] = boxesData.slice(i * 4, (i + 1) * 4);
                        const bboxLeft = xmin * videoWidth;
                        const bboxTop = ymin * videoHeight;
                        const bboxWidth = (xmax - xmin) * videoWidth;
                        const bboxHeight = (ymax - ymin) * videoHeight;

                        detections.push({
                            class: className,
                            score: score,
                            bbox: [bboxLeft, bboxTop, bboxWidth, bboxHeight]
                        });
                    }
                }
                // Early exit if remaining scores are below threshold (assuming scores are sorted descending)
                // Note: SSD Mobilenet outputs might not be strictly sorted, verify if using this optimization
                // if (score < scoreThreshold) {
                //    break;
                // }
            }
        } else {
            // Ensure disposal even if no detections or tensors are missing
            tf.dispose(
                [boxesTensorRaw, scoresTensorRaw, classesInfoTensorRaw, tensor, ...(outputTensors || [])].filter(t => t)
            );
        }

        tf.dispose(tensor);
        // console.timeEnd("Worker: Postprocess");
        // console.timeEnd("Worker: Detection Cycle");

        return detections;
    } catch (error) {
        console.error("Worker: Error during detection", error);
        // Optionally dispose tensors in case of error if not handled by tf.tidy
        tf.dispose(
            [
                boxesTensorRaw,
                numDetectionsTensor,
                scoresTensorRaw,
                classesInfoTensorRaw,
                tensor,
                ...(outputTensors || [])
            ].filter(t => t)
        );
        self.postMessage({ type: "error", message: `Error during detection: ${error.message}` });
        return []; // Return empty detections on error
    }
}

// Main message handler for the worker
self.onmessage = async event => {
    const { type, payload } = event.data;

    // console.log("Worker received message:", type, payload);

    switch (type) {
        case "load":
            if (!payload || !payload.modelUrl) {
                self.postMessage({ type: "error", message: "Missing modelUrl for load operation" });
                return;
            }
            labelMap = payload.labelMap || {};
            filterIds = payload.filterIds || [];
            await loadModel(payload.modelUrl);
            break;

        case "detect": {
            if (!model || !isReady) {
                console.warn("Worker: Ignoring detect message, model not ready.");
                // Post back empty detections so main thread isn't blocked waiting
                self.postMessage({ type: "detections", payload: [] });
                return;
            }
            if (!payload || !payload.imageData || !payload.width || !payload.height) {
                self.postMessage({ type: "error", message: "Missing imageData or dimensions for detect operation" });
                // Post back empty detections
                self.postMessage({ type: "detections", payload: [] });
                return;
            }
            const detections = await runDetection(payload.imageData, payload.width, payload.height);
            // Post the results back to the main thread
            self.postMessage({ type: "detections", payload: detections });
            break;
        }

        default:
            console.warn("Worker: Unknown message type received:", type);
    }
};
