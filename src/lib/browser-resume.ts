/** Refresh a web client after suspension without polling while it is hidden. */
export function observeBrowserResume(resume: () => Promise<void>): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let disposed = false;

  const handleResume = () => {
    if (disposed || document.visibilityState === "hidden" || navigator.onLine === false) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || running || document.visibilityState === "hidden" || navigator.onLine === false) return;
      running = true;
      void resume().catch(() => {
        // The caller owns user-facing connection and authentication errors.
      }).finally(() => { running = false; });
    }, 100);
  };

  document.addEventListener("visibilitychange", handleResume);
  window.addEventListener("pageshow", handleResume);
  window.addEventListener("online", handleResume);
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener("visibilitychange", handleResume);
    window.removeEventListener("pageshow", handleResume);
    window.removeEventListener("online", handleResume);
  };
}
