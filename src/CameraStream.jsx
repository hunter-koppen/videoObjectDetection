import { createElement } from "react";

import { Camera } from "./components/camera";
import "./ui/CameraStream.css";

export function CameraStream(props) {
    return (
        <Camera
            content={props.content}
            classNames={props.class}
            width={props.width.value}
            height={props.height.value}
            alignment={props.alignment}
        />
    );
}
