import { render } from "solid-js/web";
import App from "./App";
import "./index.css";
import { logger } from "./lib/logger";

logger.info("🚀 OpenCode Remote starting...");

const root = document.getElementById("root");

if (!root) {
  logger.error("❌ Root element not found!");
} else {
  logger.debug("✅ Root element found, rendering app...");
  try {
    render(() => <App />, root);
    logger.debug("✅ App rendered successfully!");
  } catch (error) {
    logger.error("❌ Error rendering app:", error);
  }
}
