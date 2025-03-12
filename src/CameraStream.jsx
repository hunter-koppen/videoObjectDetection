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
            content={props.content}
            classNames={props.class}
            width={props.width.value}
            height={props.height.value}
            alignment={props.alignment}
            takeScreenshot={props.takeScreenshot}
            onScreenshot={handleScreenshotTaken}
            screenshotBase64String={props.screenshotBase64String}
        />
    );
}
