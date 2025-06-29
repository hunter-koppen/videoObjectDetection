/* eslint-disable no-undef */
import { pipeline, env } from "@xenova/transformers";

// Configure the environment to allow remote models and disable local-only mode.
// This is crucial for environments where the default model path is not accessible.
env.allowRemoteModels = true;
env.local_files_only = false;

class ClassificationPipeline {
    static classifier = null;
    static textPrompt = null;
    static negativeTextPrompt = null;

    static async load({ modelName, textPrompt, negativeTextPrompt }) {
        if (this.classifier && this.textPrompt === textPrompt && this.negativeTextPrompt === negativeTextPrompt) {
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
            this.negativeTextPrompt = negativeTextPrompt;
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
            // By adding a neutral/opposite label, we force the model to make a choice,
            // which gives a more realistic score instead of always defaulting to 1.0.
            const candidateLabels = [this.textPrompt, this.negativeTextPrompt];
            const outputs = await this.classifier(input, candidateLabels);

            // We only want to return the classification for the original prompt.
            const mainClassification = outputs.find(o => o.label === this.textPrompt);

            // If for some reason the prompt label isn't in the output, send an empty array
            // to avoid errors in the main thread. The component is expecting an array.
            const payloadToSend = mainClassification ? [mainClassification] : [];

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
    }
};
