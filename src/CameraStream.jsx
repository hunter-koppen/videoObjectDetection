import { createElement } from "react";

import { Camera } from "./components/camera";
import "./ui/CameraStream.css";

export function CameraStream(props) {
    return <Camera sampleText={props.sampleText} classNames={props.class} />;
}
