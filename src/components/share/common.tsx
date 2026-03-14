import { createSignal, onCleanup } from "solid-js"

/**
 * Creates a reactive elapsed timer that ticks every second.
 * Returns a signal with the elapsed milliseconds since `startTime`.
 * Stops ticking when `running()` returns false.
 */
export function createElapsedTimer(startTime: () => number, running: () => boolean) {
  const [elapsed, setElapsed] = createSignal(Date.now() - startTime())

  const timer = setInterval(() => {
    if (running()) {
      setElapsed(Date.now() - startTime())
    }
  }, 1000)

  onCleanup(() => clearInterval(timer))

  return () => elapsed()
}

export function createOverflow() {
  const [overflow, setOverflow] = createSignal(false)
  return {
    get status() {
      return overflow()
    },
    ref(el: HTMLElement) {
      const ro = new ResizeObserver(() => {
        setOverflow(el.scrollHeight > el.clientHeight + 1)
      })
      ro.observe(el)

      onCleanup(() => {
        ro.disconnect()
      })
    },
  }
}

export function formatDuration(ms: number): string {
  const ONE_SECOND = 1000
  const ONE_MINUTE = 60 * ONE_SECOND

  if (ms >= ONE_MINUTE) {
    const minutes = Math.floor(ms / ONE_MINUTE)
    return minutes === 1 ? `1min` : `${minutes}mins`
  }

  if (ms >= ONE_SECOND) {
    const seconds = Math.floor(ms / ONE_SECOND)
    return `${seconds}s`
  }

  return `${ms}ms`
}

/** Format token count: <1000 as-is, ≥1000 as X.XK, ≥1M as X.XM */
export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return (count / 1000).toFixed(1) + "K";
  return (count / 1_000_000).toFixed(1) + "M";
}

/** Format USD cost with 4 decimal places */
export function formatCost(cost: number): string {
  return "$" + cost.toFixed(4);
}
