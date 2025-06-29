import "./ui/CameraStream.css";

import Big from "big.js";
import { Camera } from "./components/camera";
import { createElement } from "react";

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

    const handleValidationTick = (motionScore, classificationScore) => {
        if (props.motionScore) {
            props.motionScore.setValue(new Big(motionScore.toFixed(2)));
        }
        if (props.classificationScore) {
            props.classificationScore.setValue(new Big(classificationScore.toFixed(2)));
        }
        if (props.onValidationTick && props.onValidationTick.canExecute) {
            props.onValidationTick.execute();
        }
    };

    return (
        <Camera
            contentTop={props.contentTop}
            contentMiddle={props.contentMiddle}
            contentBottom={props.contentBottom}
            loadingContent={props.loadingContent}
            classNames={props.class}
            width={props.width.value}
            height={props.height.value}
            takeScreenshot={props.takeScreenshot}
            onScreenshot={handleScreenshotTaken}
            screenshotBase64String={props.screenshotBase64String}
            startRecording={props.startRecording}
            showRecordingIndicator={props.showRecordingIndicator}
            onRecordingComplete={handleRecordingComplete}
            audioEnabled={props.audioEnabled?.value ?? true}
            facingMode={props.facingMode?.value ?? "environment"}
            objectDetectionEnabled={props.objectDetectionEnabled?.value ?? false}
            torchEnabled={props.torchEnabled?.value ?? false}
            blurScore={props.blurScore}
            badLightingScore={props.badLightingScore}
            modelName={props.modelName?.value ?? "Xenova/clip-vit-base-patch32"}
            textPrompt={props.textPrompt?.value ?? "plant"}
            negativeTextPrompt={props.negativeTextPrompt?.value ?? "not a plant"}
            showTopClassification={props.showTopClassification?.value ?? true}
            onValidationTick={handleValidationTick}
            validationInterval={props.validationInterval?.value?.toNumber() ?? 1000}
        />
    );
}
