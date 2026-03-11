// =============================================================================
// Browser Performance Collector
//
// This script is designed to run inside the browser (via Halo AI Browser's
// browser_evaluate or as an injected script) against a running CodeMux instance.
//
// It collects real-world rendering performance metrics during user interaction
// or simulated streaming. Export it as a module for use in E2E tests, or
// paste the collector functions directly into browser_evaluate.
//
// Usage with Halo AI Browser:
//   1. Navigate to dev server (http://localhost:5173)
//   2. Open a chat session
//   3. Run browser_evaluate with startCollecting() before triggering streaming
//   4. After streaming completes, run browser_evaluate with stopCollecting()
//   5. Read the report
// =============================================================================

/**
 * Performance metrics collected during a measurement window.
 */
export interface PerfMetrics {
  /** Duration of the measurement window in ms */
  durationMs: number;

  /** Frames per second samples (one per second) */
  fps: {
    samples: number[];
    avg: number;
    min: number;
    max: number;
  };

  /** Long tasks (>50ms main thread blocks) detected via PerformanceObserver */
  longTasks: {
    count: number;
    totalMs: number;
    worstMs: number;
    /** Top 5 longest tasks */
    top5: Array<{ durationMs: number; startTime: number }>;
  };

  /** DOM metrics */
  dom: {
    nodeCount: number;
    /** Node count of the message list container specifically */
    messageListNodeCount: number;
  };

  /** Memory (Chrome/Edge only) */
  memory: {
    usedHeapMB: number;
    totalHeapMB: number;
    /** Growth during measurement window */
    growthMB: number;
  } | null;

  /** DOM mutation activity */
  mutations: {
    totalMutations: number;
    totalAddedNodes: number;
    totalRemovedNodes: number;
    /** Mutations per second */
    rate: number;
  };
}

/**
 * Verdict: pass/fail thresholds for acceptable performance.
 */
export interface PerfVerdict {
  /** FPS never dropped below 24 */
  smoothScrolling: boolean;
  /** No long task exceeded 100ms (perceptible jank threshold) */
  noPerceptibleJank: boolean;
  /** Memory growth < 50MB during test */
  memoryStable: boolean;
  /** Fewer than 5 long tasks total */
  fewLongTasks: boolean;
  /** Overall pass */
  pass: boolean;
}

// ---------------------------------------------------------------------------
// Collector state
// ---------------------------------------------------------------------------

let _collecting = false;
let _startTime = 0;
let _startMemory = 0;

// FPS tracking
let _frameCount = 0;
let _lastFpsTime = 0;
let _fpsSamples: number[] = [];
let _rafId = 0;

// Long tasks
let _longTasks: Array<{ durationMs: number; startTime: number }> = [];
let _perfObserver: PerformanceObserver | null = null;

// Mutations
let _mutationObserver: MutationObserver | null = null;
let _totalMutations = 0;
let _totalAddedNodes = 0;
let _totalRemovedNodes = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start collecting performance metrics.
 * Call this BEFORE triggering the action you want to measure.
 */
export function startCollecting(): void {
  if (_collecting) {
    console.warn("[PerfCollector] Already collecting. Call stopCollecting() first.");
    return;
  }

  _collecting = true;
  _startTime = performance.now();
  _startMemory = (performance as any).memory?.usedJSHeapSize ?? 0;

  // Reset state
  _fpsSamples = [];
  _longTasks = [];
  _totalMutations = 0;
  _totalAddedNodes = 0;
  _totalRemovedNodes = 0;
  _frameCount = 0;
  _lastFpsTime = performance.now();

  // --- FPS counter ---
  function trackFrames() {
    if (!_collecting) return;
    _frameCount++;
    const now = performance.now();
    if (now - _lastFpsTime >= 1000) {
      _fpsSamples.push(_frameCount);
      _frameCount = 0;
      _lastFpsTime = now;
    }
    _rafId = requestAnimationFrame(trackFrames);
  }
  _rafId = requestAnimationFrame(trackFrames);

  // --- Long Task observer ---
  try {
    _perfObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        _longTasks.push({
          durationMs: Math.round(entry.duration * 10) / 10,
          startTime: Math.round(entry.startTime),
        });
      }
    });
    _perfObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    // PerformanceObserver for longtask may not be available in all browsers
    console.warn("[PerfCollector] Long task observation not available");
  }

  // --- Mutation observer on message list ---
  const messageList =
    document.querySelector('[data-testid="message-list"]') ??
    document.querySelector('[data-component="session-turn"]')?.parentElement ??
    document.querySelector("main");

  if (messageList) {
    _mutationObserver = new MutationObserver((mutations) => {
      _totalMutations += mutations.length;
      for (const m of mutations) {
        _totalAddedNodes += m.addedNodes.length;
        _totalRemovedNodes += m.removedNodes.length;
      }
    });
    _mutationObserver.observe(messageList, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  console.log("[PerfCollector] Started collecting metrics");
}

/**
 * Stop collecting and return the metrics report.
 */
export function stopCollecting(): { metrics: PerfMetrics; verdict: PerfVerdict; report: string } {
  if (!_collecting) {
    throw new Error("[PerfCollector] Not collecting. Call startCollecting() first.");
  }

  _collecting = false;
  cancelAnimationFrame(_rafId);
  _perfObserver?.disconnect();
  _perfObserver = null;
  _mutationObserver?.disconnect();
  _mutationObserver = null;

  // Flush any remaining FPS count
  if (_frameCount > 0) {
    const elapsed = performance.now() - _lastFpsTime;
    if (elapsed > 100) {
      // Only add if we have a meaningful sample
      _fpsSamples.push(Math.round((_frameCount / elapsed) * 1000));
    }
  }

  const durationMs = performance.now() - _startTime;
  const endMemory = (performance as any).memory?.usedJSHeapSize ?? 0;

  // Count DOM nodes
  const allNodes = document.querySelectorAll("*").length;
  const messageListEl =
    document.querySelector('[data-testid="message-list"]') ??
    document.querySelector('[data-component="session-turn"]')?.parentElement;
  const messageListNodes = messageListEl
    ? messageListEl.querySelectorAll("*").length
    : 0;

  // Sort long tasks
  _longTasks.sort((a, b) => b.durationMs - a.durationMs);

  const metrics: PerfMetrics = {
    durationMs: Math.round(durationMs),
    fps: {
      samples: _fpsSamples,
      avg: _fpsSamples.length > 0
        ? Math.round(_fpsSamples.reduce((a, b) => a + b, 0) / _fpsSamples.length)
        : 0,
      min: _fpsSamples.length > 0 ? Math.min(..._fpsSamples) : 0,
      max: _fpsSamples.length > 0 ? Math.max(..._fpsSamples) : 0,
    },
    longTasks: {
      count: _longTasks.length,
      totalMs: Math.round(_longTasks.reduce((sum, t) => sum + t.durationMs, 0)),
      worstMs: _longTasks.length > 0 ? _longTasks[0].durationMs : 0,
      top5: _longTasks.slice(0, 5),
    },
    dom: {
      nodeCount: allNodes,
      messageListNodeCount: messageListNodes,
    },
    memory:
      _startMemory > 0
        ? {
            usedHeapMB: Math.round((endMemory / 1024 / 1024) * 10) / 10,
            totalHeapMB:
              Math.round(
                (((performance as any).memory?.totalJSHeapSize ?? 0) / 1024 / 1024) * 10,
              ) / 10,
            growthMB: Math.round(((endMemory - _startMemory) / 1024 / 1024) * 10) / 10,
          }
        : null,
    mutations: {
      totalMutations: _totalMutations,
      totalAddedNodes: _totalAddedNodes,
      totalRemovedNodes: _totalRemovedNodes,
      rate: durationMs > 0 ? Math.round((_totalMutations / durationMs) * 1000) : 0,
    },
  };

  const verdict: PerfVerdict = {
    smoothScrolling: metrics.fps.min >= 24,
    noPerceptibleJank: metrics.longTasks.worstMs < 100,
    memoryStable: metrics.memory ? metrics.memory.growthMB < 50 : true,
    fewLongTasks: metrics.longTasks.count < 5,
    pass: false,
  };
  verdict.pass =
    verdict.smoothScrolling &&
    verdict.noPerceptibleJank &&
    verdict.memoryStable &&
    verdict.fewLongTasks;

  const report = formatReport(metrics, verdict);
  console.log(report);

  return { metrics, verdict, report };
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function formatReport(metrics: PerfMetrics, verdict: PerfVerdict): string {
  const lines: string[] = [
    "",
    "╔══════════════════════════════════════════════════════════════╗",
    "║              CodeMux Performance Report                     ║",
    "╠══════════════════════════════════════════════════════════════╣",
    "",
    `  Duration: ${(metrics.durationMs / 1000).toFixed(1)}s`,
    "",
    "  ┌─ FPS ──────────────────────────────────────────────────┐",
    `  │  Average: ${metrics.fps.avg}  Min: ${metrics.fps.min}  Max: ${metrics.fps.max}`,
    `  │  Samples: [${metrics.fps.samples.join(", ")}]`,
    "  └────────────────────────────────────────────────────────┘",
    "",
    "  ┌─ Long Tasks (>50ms) ───────────────────────────────────┐",
    `  │  Count: ${metrics.longTasks.count}  Total: ${metrics.longTasks.totalMs}ms  Worst: ${metrics.longTasks.worstMs}ms`,
  ];

  if (metrics.longTasks.top5.length > 0) {
    lines.push(
      `  │  Top 5: ${metrics.longTasks.top5.map((t) => `${t.durationMs}ms`).join(", ")}`,
    );
  }

  lines.push("  └────────────────────────────────────────────────────────┘");
  lines.push("");
  lines.push("  ┌─ DOM ───────────────────────────────────────────────────┐");
  lines.push(
    `  │  Total nodes: ${metrics.dom.nodeCount}  Message list: ${metrics.dom.messageListNodeCount}`,
  );
  lines.push("  └────────────────────────────────────────────────────────┘");
  lines.push("");

  if (metrics.memory) {
    lines.push("  ┌─ Memory ─────────────────────────────────────────────────┐");
    lines.push(
      `  │  Used: ${metrics.memory.usedHeapMB}MB  Total: ${metrics.memory.totalHeapMB}MB  Growth: ${metrics.memory.growthMB > 0 ? "+" : ""}${metrics.memory.growthMB}MB`,
    );
    lines.push("  └────────────────────────────────────────────────────────┘");
    lines.push("");
  }

  lines.push("  ┌─ DOM Mutations ───────────────────────────────────────────┐");
  lines.push(
    `  │  Total: ${metrics.mutations.totalMutations}  Added: ${metrics.mutations.totalAddedNodes}  Removed: ${metrics.mutations.totalRemovedNodes}`,
  );
  lines.push(`  │  Rate: ${metrics.mutations.rate} mutations/sec`);
  lines.push("  └────────────────────────────────────────────────────────┘");
  lines.push("");
  lines.push("  ┌─ Verdict ─────────────────────────────────────────────────┐");
  lines.push(`  │  ${verdict.smoothScrolling ? "✅" : "❌"} Smooth scrolling (min FPS ≥ 24)`);
  lines.push(`  │  ${verdict.noPerceptibleJank ? "✅" : "❌"} No perceptible jank (worst long task < 100ms)`);
  lines.push(`  │  ${verdict.memoryStable ? "✅" : "❌"} Memory stable (growth < 50MB)`);
  lines.push(`  │  ${verdict.fewLongTasks ? "✅" : "❌"} Few long tasks (< 5 total)`);
  lines.push(`  │  ${verdict.pass ? "✅ PASS" : "❌ FAIL"}`);
  lines.push("  └────────────────────────────────────────────────────────┘");
  lines.push("");
  lines.push("╚══════════════════════════════════════════════════════════════╝");

  return lines.join("\n");
}
