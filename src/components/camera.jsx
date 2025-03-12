import { createElement } from "react";
import Webcam from "react-webcam";

export function Camera(props) {
    const alignment = props.alignment || "top";
    
    return (
        <div className={"mx-camerastream " + props.classNames}>
            <Webcam height={props.height} width={props.width} screenshotFormat="image/jpeg" />
            <div className={`camera-content-overlay camera-align-${alignment}`}>
                {props.content}
            </div>
        </div>
    );
}
