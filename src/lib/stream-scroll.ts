interface ScrollViewport {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function isNearScrollBottom(viewport: ScrollViewport): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
}

/** Coalesce layout updates without overriding a later user scroll or session switch. */
export function createStreamScroll(options: {
  viewport: () => ScrollViewport | undefined;
  sessionId: () => string | null;
  following: () => boolean;
}) {
  let scrollRafId: number | null = null;

  const cancel = () => {
    if (scrollRafId !== null) cancelAnimationFrame(scrollRafId);
    scrollRafId = null;
  };

  const schedule = () => {
    if (scrollRafId !== null || !options.following()) return;
    const viewport = options.viewport();
    const sessionId = options.sessionId();
    if (!viewport) return;
    const scrollTop = viewport.scrollTop;
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      if (!options.following() || options.viewport() !== viewport || options.sessionId() !== sessionId) return;
      // A scrollbar drag may change the position before its scroll event runs.
      if (viewport.scrollTop < scrollTop) return;
      viewport.scrollTop = viewport.scrollHeight;
    });
  };

  return { schedule, cancel };
}
