import { configureDevIsolatedAppPaths, runtimeHost } from "./runtime-host";

configureDevIsolatedAppPaths();
process.env.CODEMUX_DESKTOP_SHELL = "1";
process.env.CODEMUX_RUNTIME_WEB_MODE = runtimeHost.isPackaged ? "static" : "dev-proxy";

await import("./app-main");
