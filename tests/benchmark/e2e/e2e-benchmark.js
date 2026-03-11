async (params) => {
  // E2E Performance Benchmark - Browser Runner Script
  // Simplified: assumes already on /chat page with auth token set.
  // Collects FPS, long tasks, DOM mutations, memory during message exchange.

  var msgCount = (params && params.messageCount) || 3;
  var waitMs = (params && params.waitMs) || 1200;

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function sendMsg(text) {
    var ta = document.querySelector("textarea");
    if (!ta) throw new Error("no textarea");
    ta.focus();
    var desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    desc.set.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    var handler = ta["$$keydown"];
    var data = ta["$$keydownData"];
    var evt = new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    });
    if (data !== undefined) handler.call(ta, data, evt);
    else if (handler) handler.call(ta, evt);
  }

  // Create session
  var btn = document.querySelector("button[title='New session']");
  if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
  await sleep(1500);

  if (!document.querySelector("textarea")) return { error: "no textarea after session create" };

  // Perf collection
  var fpsSamples = [];
  var frameCount = 0;
  var lastFpsTime = performance.now();
  var collecting = true;
  var longTasks = [];
  var totalMutations = 0;
  var addedNodes = 0;
  var removedNodes = 0;

  function trackFrames() {
    if (!collecting) return;
    frameCount++;
    var now = performance.now();
    if (now - lastFpsTime >= 1000) {
      fpsSamples.push(frameCount);
      frameCount = 0;
      lastFpsTime = now;
    }
    requestAnimationFrame(trackFrames);
  }
  requestAnimationFrame(trackFrames);

  var perfObs = null;
  try {
    perfObs = new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        longTasks.push({ durationMs: Math.round(entries[i].duration), startTime: Math.round(entries[i].startTime) });
      }
    });
    perfObs.observe({ entryTypes: ["longtask"] });
  } catch(e) {}

  var msgArea = document.querySelector("main");
  var mutObs = null;
  if (msgArea) {
    mutObs = new MutationObserver(function(muts) {
      totalMutations += muts.length;
      for (var j = 0; j < muts.length; j++) {
        addedNodes += muts[j].addedNodes.length;
        removedNodes += muts[j].removedNodes.length;
      }
    });
    mutObs.observe(msgArea, { childList: true, subtree: true, characterData: true });
  }

  var perfMem = performance.memory;
  var startMem = perfMem ? perfMem.usedJSHeapSize : 0;

  var prompts = [
    "Explain the architecture of this project in detail",
    "Write a comprehensive test suite for the auth module",
    "Refactor the database connection pool with retry logic",
    "Analyze performance bottlenecks in the rendering pipeline",
    "Create a new feature module with CRUD operations and validation",
    "Generate detailed API documentation for all endpoints",
    "Implement a caching layer with LRU eviction",
    "Debug the race condition in WebSocket reconnection"
  ];

  var count = Math.min(msgCount, prompts.length);
  var perMsg = [];
  var overallStart = performance.now();

  for (var i = 0; i < count; i++) {
    var msgStart = performance.now();
    sendMsg(prompts[i]);
    await sleep(waitMs);
    var msgEnd = performance.now();
    perMsg.push({
      msg: i,
      prompt: prompts[i].slice(0, 45),
      durationMs: Math.round(msgEnd - msgStart),
      domNodes: document.querySelectorAll("*").length,
      turns: document.querySelectorAll("[data-component='session-turn']").length
    });
  }

  var totalMs = Math.round(performance.now() - overallStart);

  // Stop
  collecting = false;
  if (perfObs) perfObs.disconnect();
  if (mutObs) mutObs.disconnect();

  if (frameCount > 0) {
    var elapsed = performance.now() - lastFpsTime;
    if (elapsed > 100) fpsSamples.push(Math.round((frameCount / elapsed) * 1000));
  }

  var endMem = perfMem ? perfMem.usedJSHeapSize : 0;
  var fpsSum = 0;
  for (var k = 0; k < fpsSamples.length; k++) fpsSum += fpsSamples[k];
  longTasks.sort(function(a, b) { return b.durationMs - a.durationMs; });

  var fpsMin = fpsSamples.length > 0 ? Math.min.apply(null, fpsSamples) : 0;
  var worstTask = longTasks.length > 0 ? longTasks[0].durationMs : 0;
  var memGrowth = startMem > 0 ? (endMem - startMem) / 1024 / 1024 : 0;

  return {
    scenario: "instant-response",
    totalMessages: count,
    totalDurationMs: totalMs,
    avgMessageMs: Math.round(totalMs / count),
    perMessage: perMsg,
    fps: {
      samples: fpsSamples,
      avg: fpsSamples.length > 0 ? Math.round(fpsSum / fpsSamples.length) : 0,
      min: fpsMin,
      max: fpsSamples.length > 0 ? Math.max.apply(null, fpsSamples) : 0
    },
    longTasks: {
      count: longTasks.length,
      worstMs: worstTask,
      top5: longTasks.slice(0, 5)
    },
    dom: {
      finalNodes: document.querySelectorAll("*").length
    },
    memory: startMem > 0 ? {
      startMB: Math.round((startMem / 1024 / 1024) * 10) / 10,
      endMB: Math.round((endMem / 1024 / 1024) * 10) / 10,
      growthMB: Math.round(memGrowth * 10) / 10
    } : null,
    mutations: {
      total: totalMutations,
      added: addedNodes,
      removed: removedNodes,
      ratePerSec: totalMs > 0 ? Math.round((totalMutations / totalMs) * 1000) : 0
    },
    verdict: {
      smoothFps: fpsMin >= 24,
      noJank: worstTask < 100,
      memoryOk: memGrowth < 50,
      fewLongTasks: longTasks.length < 5,
      pass: (fpsMin >= 24) && (worstTask < 100) && (memGrowth < 50) && (longTasks.length < 5)
    }
  };
}
