import { render } from "solid-js/web";
import App from "../App";
import { PwaControls } from "./PwaControls";
import "../index.css";
import "./web.css";

document.documentElement.classList.add("web-client");

// The visual viewport follows the on-screen keyboard on mobile browsers.
const syncViewport = () => {
  const viewport = window.visualViewport;
  if (!viewport || viewport.scale !== 1) return;
  document.documentElement.style.setProperty("--web-viewport-height", `${viewport.height}px`);
};
syncViewport();
window.visualViewport?.addEventListener("resize", syncViewport);
window.addEventListener("pageshow", syncViewport);

const root = document.getElementById("root");
if (root) render(() => <App><PwaControls /></App>, root);
