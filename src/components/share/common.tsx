import { createSignal, onCleanup } from "solid-js"

export interface EngineBadge {
  label: string;
  class: string;
}

/** Get display badge (label + CSS class) for an engine type. */
export function getEngineBadge(engineType?: string): EngineBadge | null {
  if (!engineType) return null;
  switch (engineType) {
    case "opencode": return { label: "OC", class: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" };
    case "copilot": return { label: "Copilot", class: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" };
    case "claude": return { label: "Claude", class: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" };
    default: return { label: engineType, class: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400" };
  }
}

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
  if (count < 999_950) return (count / 1000).toFixed(1) + "K";
  return (count / 1_000_000).toFixed(1) + "M";
}

/** Format USD cost with 4 decimal places */
export function formatCost(cost: number): string {
  return "$" + cost.toFixed(4);
}

/** Format cost with unit awareness. Accepts optional i18n accessor for localized premium request labels. */
export function formatCostWithUnit(cost: number, unit?: "usd" | "premium_requests", t?: () => { tokenUsage: { premiumRequest: string; premiumRequests: string } }): string {
  if (unit === "premium_requests") {
    // Use fractional display for small values to avoid showing "0"
    const display = cost < 1 && cost > 0 ? cost.toFixed(3) : String(Math.round(cost));
    if (t) {
      const key = cost === 1 ? "premiumRequest" : "premiumRequests";
      return t().tokenUsage[key].replace("{count}", display);
    }
    return cost === 1 ? `${display} premium request` : `${display} premium requests`;
  }
  return "$" + cost.toFixed(4);
}
