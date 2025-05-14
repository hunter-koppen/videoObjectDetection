import webWorkerLoader from "rollup-plugin-web-worker-loader";

export default args => {
    const { configDefaultConfig } = args;

    const configurePlugins = config => {
        if (!config.plugins) {
            config.plugins = [];
        }
        config.plugins.unshift(
            webWorkerLoader({
                targetPlatform: "browser",
                sourceMap: args.mode !== "production",
                inline: true
            })
        );
    };

    configDefaultConfig.forEach(config => {
        let applyLoader = false;
        if (config.output) {
            const outputOptions = Array.isArray(config.output) ? config.output[0] : config.output;
            if (
                outputOptions &&
                (outputOptions.format === "umd" || outputOptions.format === "esm" || outputOptions.format === "iife")
            ) {
                applyLoader = true;
            }
        }
        if (!applyLoader && typeof config.input === "string" && config.input.includes("CameraStream.jsx")) {
            applyLoader = true;
        }
        if (applyLoader) {
            configurePlugins(config);
        }
    });

    return configDefaultConfig;
};
