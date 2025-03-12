import { createElement } from "react";

import { HelloWorldSample } from "./components/HelloWorldSample";
import "./ui/CameraStream.css";

export function CameraStream({ sampleText }) {
    return <HelloWorldSample sampleText={sampleText} />;
}
