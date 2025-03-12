import { createElement } from "react";
import Webcam from "react-webcam";

export function Camera(props) {
    return <div className={"mx-camerastream " + props.classNames}>
        <Webcam />
    </div>;
}
