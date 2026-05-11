import { configureDevIsolatedAppPaths } from "./services/app-paths";

configureDevIsolatedAppPaths();

await import("./app-main");
