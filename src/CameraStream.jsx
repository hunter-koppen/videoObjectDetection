import { createElement } from "react";

import "./ui/CameraStream.css";
import { Camera } from "./components/camera";

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
            objectDetectionEnabled={props.objectDetectionEnabled ?? false}
            modelUrl={props.modelUrl?.value ?? null}
            labelMapString={props.labelMapString?.value ?? "{}"}
            filterClassIdsString={props.filterClassIdsString?.value ?? ""}
            scoreThreshold={props.scoreThreshold?.value?.toNumber() ?? 0.5}
        />
    );
}
