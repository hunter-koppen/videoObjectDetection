import * as tf from "@tensorflow/tfjs";

let model = null;
let labelMap = {};
let filterIds = [];
let isReady = false;
let scoreThreshold = 0.5;

async function loadModel(modelUrl) {
    if (model) {
        return true;
    }
    try {
        await tf.setBackend("webgl");
        model = await tf.loadGraphModel(modelUrl);
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
        return [];
    }

    let tensor;
    let outputTensors;

    try {
        tensor = tf.tidy(() => {
            const img = tf.browser.fromPixels(imageData);
            const resized = tf.image.resizeBilinear(img, [320, 320]);
            const int32Input = resized.cast("int32");
            return int32Input.expandDims(0);
        });

        // Execute model with specific output names
        const outputNodeNames = [
            "Identity_1:0", // Final boxes [1, 100, 4]
            "Identity_5:0", // Num detections [1]
            "Identity_4:0", // Scores [1, 100]
            "Identity_3:0" // Class probabilities [1, 100, 9]
        ];

        outputTensors = await model.executeAsync(tensor, outputNodeNames);
        const [boxesTensorRaw, numDetectionsTensor, scoresTensorRaw, classesInfoTensorRaw] = outputTensors;

        const numDetectionsData = await numDetectionsTensor.data();
        const numDetections = Math.round(numDetectionsData[0]);
        tf.dispose(numDetectionsTensor);

        const detections = [];

        if (numDetections > 0 && boxesTensorRaw && scoresTensorRaw && classesInfoTensorRaw) {
            const scoresData = await scoresTensorRaw.squeeze().data();
            tf.dispose(scoresTensorRaw);

            const classProbs = await classesInfoTensorRaw.squeeze().data();
            tf.dispose(classesInfoTensorRaw);

            // Convert class probabilities to class IDs
            const classIdsData = new Array(numDetections);
            for (let i = 0; i < numDetections; i++) {
                let maxProb = -1;
                let bestClass = 0;
                for (let j = 0; j < 9; j++) {
                    const prob = classProbs[i * 9 + j];
                    if (prob > maxProb) {
                        maxProb = prob;
                        bestClass = j;
                    }
                }
                classIdsData[i] = bestClass;
            }

            const boxesData = await boxesTensorRaw.squeeze().data();
            tf.dispose(boxesTensorRaw);

            for (let i = 0; i < numDetections; i++) {
                const score = scoresData[i];
                const classId = classIdsData[i];

                if (score >= scoreThreshold) {
                    if (filterIds.length === 0 || filterIds.includes(classId)) {
                        const className = labelMap[classId] || `Class ${classId}`;

                        if (boxesData.length >= (i + 1) * 4) {
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
                }
            }
        }

        tf.dispose(tensor);
        return detections;
    } catch (error) {
        console.error("Worker: Error during detection", error);
        tf.dispose([tensor, ...(outputTensors || [])].filter(t => t));
        self.postMessage({ type: "error", message: `Error during detection: ${error.message}` });
        return [];
    }
}

// Main message handler for the worker
self.onmessage = async event => {
    const { type, payload } = event.data;

    switch (type) {
        case "load":
            if (!payload || !payload.modelUrl) {
                self.postMessage({ type: "error", message: "Missing modelUrl for load operation" });
                return;
            }
            labelMap = payload.labelMap || {};
            filterIds = payload.filterIds || [];
            scoreThreshold = payload.scoreThreshold || 0.5;
            await loadModel(payload.modelUrl);
            break;

        case "detect": {
            if (!model || !isReady) {
                self.postMessage({ type: "detections", payload: [] });
                return;
            }
            if (!payload || !payload.imageData || !payload.width || !payload.height) {
                self.postMessage({ type: "error", message: "Missing imageData or dimensions for detect operation" });
                self.postMessage({ type: "detections", payload: [] });
                return;
            }
            const detections = await runDetection(payload.imageData, payload.width, payload.height);
            self.postMessage({ type: "detections", payload: detections });
            break;
        }

        default:
            console.warn("Worker: Unknown message type received:", type);
    }
};
