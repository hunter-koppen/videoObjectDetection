import { createElement } from "react";

import { Camera } from "./components/camera";
import "./ui/CameraStream.css";

export function CameraStream(props) {
    const handleScreenshotTaken = base64String => {
        const cleanBase64 = base64String.replace(/^data:image\/jpeg;base64,/, "");
        if (props.screenshotBase64String) {
            props.screenshotBase64String.setValue(cleanBase64);
            if (props.onScreenshotCapture && props.onScreenshotCapture.canExecute) {
                props.onScreenshotCapture.execute();
            }
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
            audioEnabled={props.audioEnabled?.value ?? true}
            facingMode={props.facingMode?.value ?? "environment"}
        />
    );
}
