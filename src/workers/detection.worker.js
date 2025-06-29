/* eslint-disable no-undef */
import { pipeline, env } from "@xenova/transformers";

// Configure the environment to allow remote models and disable local-only mode.
// This is crucial for environments where the default model path is not accessible.
env.allowRemoteModels = true;
env.local_files_only = false;

class ClassificationPipeline {
    static classifier = null;
    static textPrompt = null;

    static async load({ modelName, textPrompt }) {
        if (this.classifier && this.textPrompt === textPrompt) {
            self.postMessage({ type: "ready" });
            return;
        }

        try {
            self.postMessage({ type: "loading", message: "Loading classification model..." });
            // Use the pipeline function directly since we imported it specifically
            this.classifier = await pipeline("zero-shot-image-classification", modelName, {
                progress_callback: data => {
                    if (data.status === "progress") {
                        const progress = Math.round(data.progress);
                        self.postMessage({ type: "loading", message: `Loading model... ${progress}%` });
                    }
                }
            });
            this.textPrompt = textPrompt;
            self.postMessage({ type: "ready" });
        } catch (err) {
            self.postMessage({ type: "error", message: `Failed to load model: ${err.message}` });
        }
    }

    static async classify(payload) {
        if (!this.classifier) {
            self.postMessage({ type: "error", message: "Classification failed: classifier not loaded." });
            return;
        }

        try {
            console.log("Worker: Received payload:", payload);
            
            // Check for data URL first (most compatible), then Blob, then ImageData
            let input;
            if (payload.imageDataURL) {
                // Use the data URL directly - Transformers.js supports string inputs
                input = payload.imageDataURL;
                console.log("Worker: Using data URL input, length:", input.length);
            } else if (payload.imageBlob) {
                // Use the Blob directly - Transformers.js supports this natively
                input = payload.imageBlob;
                console.log("Worker: Using Blob input:", input);
            } else if (payload.imageData) {
                // Fallback to ImageData processing for backwards compatibility
                console.log("Worker: Received imageData, converting to canvas");
                const { data, width, height } = payload.imageData;
                const imageData = new ImageData(new Uint8ClampedArray(data), width, height);
                const canvas = new OffscreenCanvas(width, height);
                const ctx = canvas.getContext("2d");
                ctx.putImageData(imageData, 0, 0);
                input = canvas;
            } else {
                throw new Error("No valid image data received");
            }

            console.log("Worker: About to call classifier with input type:", typeof input, "and prompt:", this.textPrompt);

            // Pass the input to the classifier
            const outputs = await this.classifier(input, [this.textPrompt]);
            console.log("Worker: Classification outputs:", outputs);
            self.postMessage({ type: "classifications", payload: outputs });
        } catch (err) {
            console.error("Worker: Classification error details:", err);
            self.postMessage({ type: "error", message: `Classification failed: ${err.message}` });
        }
    }
}

self.onmessage = async event => {
    const { type, payload } = event.data;

    switch (type) {
        case "load":
            await ClassificationPipeline.load(payload);
            break;

        case "detect": // The main thread still sends "detect", which we handle here.
            await ClassificationPipeline.classify(payload);
            break;
    }
};
