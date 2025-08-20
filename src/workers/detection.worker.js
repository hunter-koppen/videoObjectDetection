/* eslint-disable no-undef */
import { pipeline, env } from "@xenova/transformers";

// Configure the environment to allow remote models and disable local-only mode.
// This is crucial for environments where the default model path is not accessible.
env.allowRemoteModels = true;
// eslint-disable-next-line camelcase
env.local_files_only = false;

// Detect iOS environment inside the worker
const isIOS = (() => {
    try {
        const ua = (self.navigator && self.navigator.userAgent) || "";
        const hasTouchMac =
            typeof self.navigator !== "undefined" && self.navigator.maxTouchPoints > 1 && /Mac/.test(ua);
        return /iPad|iPhone|iPod/.test(ua) || hasTouchMac;
    } catch (e) {
        return false;
    }
})();

// Platform-specific ONNX/WASM tuning
if (isIOS) {
    // iOS Safari stability: avoid multi-threaded/SIMD wasm and disable cache/FS to reduce storage churn
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.simd = false;
    env.useBrowserCache = false;
    env.useFS = false;
} else {
    // On non-iOS, prefer performance features
    env.backends.onnx.wasm.numThreads = Math.max(2, (self.navigator && self.navigator.hardwareConcurrency) || 2);
    env.backends.onnx.wasm.simd = true;
    env.useBrowserCache = true;
    env.useFS = true;
}

class ClassificationPipeline {
    static classifier = null;
    static modelName = null;
    static textPrompt = null;
    static negativeTextPrompt = null;

    static async load({ modelName, textPrompt, negativeTextPrompt }) {
        // Update prompts regardless of model status
        this.textPrompt = textPrompt;
        this.negativeTextPrompt = negativeTextPrompt;

        // Only reload model if it's not loaded or if the model name changed
        if (this.classifier && this.modelName === modelName) {
            self.postMessage({ type: "ready" });
            return;
        }

        try {
            self.postMessage({ type: "loading", message: "Loading classification model..." });
            this.classifier = await pipeline("zero-shot-image-classification", modelName, {
                // eslint-disable-next-line camelcase
                progress_callback: data => {
                    if (data.status === "progress") {
                        const progress = Math.round(data.progress);
                        self.postMessage({ type: "loading", message: `Loading model... ${progress}%` });
                    }
                }
            });
            this.modelName = modelName;
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
            const input = payload.imageDataURL;

            // Split negative text prompt by commas and trim whitespace
            const negativeLabels = this.negativeTextPrompt
                ? this.negativeTextPrompt
                      .split(",")
                      .map(label => label.trim())
                      .filter(label => label.length > 0)
                : [];

            // Create candidate labels array with main prompt and all negative prompts
            const candidateLabels = [this.textPrompt, ...negativeLabels];

            const outputs = await this.classifier(input, candidateLabels);

            // Return all classifications including main prompt and negative prompts
            const payloadToSend = outputs || [];

            self.postMessage({ type: "classifications", payload: payloadToSend });
        } catch (err) {
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

        case "detect":
            await ClassificationPipeline.classify(payload);
            break;

        default:
            console.warn(`Unknown message type: ${type}`);
            break;
    }
};
