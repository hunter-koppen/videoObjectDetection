import webWorkerLoader from "rollup-plugin-web-worker-loader";

export default args => {
    const { configDefaultConfig } = args;

    let targetConfig = null;

    if (Array.isArray(configDefaultConfig)) {
        if (configDefaultConfig.length > 0) {
            targetConfig =
                configDefaultConfig.find(
                    conf =>
                        conf.output &&
                        ((Array.isArray(conf.output) &&
                            conf.output.some(out => out.format === "umd" || out.format === "esm")) ||
                            (!Array.isArray(conf.output) &&
                                (conf.output.format === "umd" || conf.output.format === "esm")))
                ) || configDefaultConfig[0];
        } else {
            console.error("Rollup custom config: configDefaultConfig is an empty array.");
            return configDefaultConfig;
        }
    } else if (typeof configDefaultConfig === "object" && configDefaultConfig !== null) {
        targetConfig = configDefaultConfig;
    } else {
        console.error("Rollup custom config: configDefaultConfig is not an array or a valid object.");
        return configDefaultConfig;
    }

    if (!targetConfig) {
        console.error("Rollup custom config: Could not determine target configuration.");
        return configDefaultConfig;
    }

    if (!targetConfig.plugins) {
        targetConfig.plugins = [];
    }

    // Add the webWorkerLoader plugin
    // It's often good to add loaders early in the plugin chain.
    targetConfig.plugins.unshift(
        webWorkerLoader({
            targetPlatform: "browser", // Specify target platform
            sourceMap: args.mode !== "production", // Enable sourcemaps for dev
            inline: true, // Keep inlining for now
            // preserveFileNames: true // May help with debugging
        })
    );

    return configDefaultConfig;
};
