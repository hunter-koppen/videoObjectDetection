import { createElement, useRef, useEffect } from "react";
import Webcam from "react-webcam";

export function Camera(props) {
    const alignment = props.alignment || "top";
    const webcamRef = useRef(null);

    useEffect(() => {
        if (props.takeScreenshot.value === true && webcamRef.current) {
            const screenshot = webcamRef.current.getScreenshot();
            if (props.onScreenshot && screenshot) {
                props.takeScreenshot.setValue(false);
                props.onScreenshot(screenshot);
            }
        }
    }, [props.takeScreenshot, props.onScreenshot]);

    return (
        <div className={"mx-camerastream " + props.classNames}>
            <Webcam ref={webcamRef} height={props.height} width={props.width} screenshotFormat="image/jpeg" />
            <div className={`camera-content-overlay camera-align-${alignment}`}>{props.content}</div>
        </div>
    );
}
