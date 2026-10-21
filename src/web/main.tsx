import { render } from "solid-js/web";
import App from "../App";
import { PwaControls } from "./PwaControls";
import "../index.css";
import "./web.css";

document.documentElement.classList.add("web-client");

// The visual viewport follows the on-screen keyboard on mobile browsers. iOS
// does not resize the layout viewport for the keyboard; it scrolls the page to
// reveal the focused field, which pushes the header off screen. Size the app to
// the visible area and undo that scroll so the input stays above the keyboard.
const syncViewport = () => {
  const viewport = window.visualViewport;
  if (!viewport || viewport.scale !== 1) return;
  document.documentElement.style.setProperty("--web-viewport-height", `${viewport.height}px`);
  if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
  document.documentElement.style.setProperty("--web-viewport-offset", `${viewport.offsetTop}px`);
};
syncViewport();
window.visualViewport?.addEventListener("resize", syncViewport);
window.visualViewport?.addEventListener("scroll", syncViewport);
window.addEventListener("scroll", syncViewport, { passive: true });
window.addEventListener("pageshow", syncViewport);

const root = document.getElementById("root");
if (root) render(() => <App><PwaControls /></App>, root);
