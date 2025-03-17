import { createElement, useState } from "react";

import { Camera } from "./components/camera";
import "./ui/CameraStream.css";

export function CameraStream(props) {
    const handleScreenshotTaken = base64String => {
        if (props.screenshotBase64String) {
            props.screenshotBase64String.setValue(base64String);
            if (props.onScreenshotCapture && props.onScreenshotCapture.canExecute) {
                props.onScreenshotCapture.execute();
            }
        }
    };

    const handleRecordingComplete = base64String => {
        if (props.recordingBase64String) {
            props.recordingBase64String.setValue(base64String);
        }
        if (props.onRecordingComplete && props.onRecordingComplete.canExecute) {
            props.onRecordingComplete.execute();
        }
    };

    const handleGeminiResponse = response => {
        console.log("Received Gemini response in CameraStream:", response);
        if (props.geminiResponseText) {
            props.geminiResponseText.setValue(response);
        }
        if (props.onGeminiResponse && props.onGeminiResponse.canExecute) {
            props.onGeminiResponse.execute();
        }
    };

    return (
        <Camera
            contentTop={props.contentTop}
            contentMiddle={props.contentMiddle}
            contentBottom={props.contentBottom}
            loadingContent={props.loadingContent || "Loading camera..."}
            classNames={props.class}
            width={props.width?.value || "100%"}
            height={props.height?.value || "100%"}
            takeScreenshot={props.takeScreenshot}
            onScreenshot={handleScreenshotTaken}
            screenshotBase64String={props.screenshotBase64String}
            startRecording={props.startRecording}
            showRecordingIndicator={props.showRecordingIndicator?.value ?? true}
            onRecordingComplete={handleRecordingComplete}
            audioEnabled={props.audioEnabled?.value ?? true}
            facingMode={props.facingMode?.value ?? "environment"}
            objectDetectionEnabled={props.objectDetectionEnabled?.value ?? false}
            // Gemini configuration
            geminiEnabled={props.geminiEnabled ?? false}
            geminiApiKey={props.geminiApiKey.value}
            geminiInitialPrompt={
                props.geminiInitialPrompt?.value ??
                "You are a real-time video analyzer. Describe what you see concisely."
            }
            geminiFramePrompt={props.geminiFramePrompt?.value ?? "What do you see in this frame?"}
            geminiFrameRate={props.geminiFrameRate?.value ?? 0.5}
            showGeminiControls={props.showGeminiControls?.value ?? true}
            onGeminiResponse={handleGeminiResponse}
        />
    );
}
