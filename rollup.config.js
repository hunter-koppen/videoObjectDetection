import webWorkerLoader from "rollup-plugin-web-worker-loader";
import { join } from "path";

export default args => {
    const { configDefaultConfig } = args;

    configDefaultConfig.forEach(config => {
        // Add the web worker loader plugin
        config.plugins.push(
            webWorkerLoader({
                targetPlatform: "browser",
                sourceMap: !config.watch
            })
        );

        // Suppress "Use of eval is strongly discouraged" warnings from onnxruntime-web
        config.onwarn = (warning, warn) => {
            if (
                warning.code === "EVAL" &&
                warning.loc &&
                warning.loc.file &&
                warning.loc.file.includes(join("node_modules", "onnxruntime-web"))
            ) {
                return; // Suppress the warning
            }
            warn(warning); // Forward other warnings
        };
    });

    return configDefaultConfig;
};
