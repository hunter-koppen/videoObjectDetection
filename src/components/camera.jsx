import { createElement, useRef, useEffect, useState, Fragment } from "react";
import Webcam from "react-webcam";

export function Camera(props) {
    const webcamRef = useRef(null);
    const [cameraReady, setCameraReady] = useState(false);

    useEffect(() => {
        if (props.takeScreenshot.value === true && webcamRef.current) {
            const screenshot = webcamRef.current.getScreenshot();
            if (props.onScreenshot && screenshot) {
                props.takeScreenshot.setValue(false);
                props.onScreenshot(screenshot);
            }
        }
    }, [props.takeScreenshot, props.onScreenshot]);

    const videoConstraints = {
        facingMode: props.facingMode || "environment"
    };

    const handleUserMedia = () => {
        setCameraReady(true);
    };

    return (
        <div className={"mx-camerastream " + props.classNames} style={{ width: "100%", height: "100%" }}>
            <Webcam
                ref={webcamRef}
                height={props.height}
                width={props.width}
                screenshotFormat="image/jpeg"
                audio={props.audioEnabled}
                videoConstraints={videoConstraints}
                onUserMedia={handleUserMedia}
            />

            {!cameraReady && props.loadingContent && <div className="camera-loading">{props.loadingContent}</div>}

            {cameraReady && (
                <Fragment>
                    {props.contentTop && (
                        <div className="camera-content-overlay camera-align-top">{props.contentTop}</div>
                    )}
                    {props.contentMiddle && (
                        <div className="camera-content-overlay camera-align-middle">{props.contentMiddle}</div>
                    )}
                    {props.contentBottom && (
                        <div className="camera-content-overlay camera-align-bottom">{props.contentBottom}</div>
                    )}
                </Fragment>
            )}
        </div>
    );
}
