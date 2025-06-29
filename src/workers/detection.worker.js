/* eslint-disable no-undef */
import { pipeline, RawImage } from "@xenova/transformers";

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
            // Use the pipeline function to load the model
            this.classifier = await pipeline("zero-shot-image-classification", modelName);
            this.textPrompt = textPrompt;
            self.postMessage({ type: "ready" });
        } catch (err) {
            self.postMessage({ type: "error", message: `Failed to load model: ${err.message}` });
        }
    }

    static async classify(imageData) {
        if (!this.classifier) {
            self.postMessage({ type: "error", message: "Classification failed: model not loaded." });
            return;
        }

        try {
            const image = await RawImage.fromImageData(imageData);
            // The pipeline handles processing and classification in one step
            const outputs = await this.classifier(image, [this.textPrompt]);

            // The pipeline returns a sorted list of results, so we just pass it on.
            // Even with one prompt, it returns an array e.g., [{ score: 0.99, label: '...' }]
            self.postMessage({ type: "classifications", payload: outputs });
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

        case "detect": // The main thread still sends "detect", we can handle that.
            await ClassificationPipeline.classify(payload.imageData);
            break;
    }
};
