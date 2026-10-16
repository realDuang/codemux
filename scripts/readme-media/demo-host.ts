// ============================================================================
// README demo host — runs the real CodeMux server (gateway, Web UI, files,
// git, terminals, scheduled tasks, devices, channels) with scripted demo
// engines and a throwaway sample project. Used by capture.ts.
//
//   bun run media:readme      # build + capture everything
//
// Environment: DEMO_HOME (default: <tmp>/codemux-readme-demo/alex), DEMO_PORT (18233).
// ============================================================================

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The demo home shows up in paths on screen; capture.ts uses /home/alex when it can.
const home = process.env.DEMO_HOME ?? join(tmpdir(), "codemux-readme-demo", "alex");
const project = join(home, "projects", "acme-shop");
const port = process.env.DEMO_PORT ?? "18233";
const marker = join(home, ".codemux-readme-demo");

if (existsSync(home)) {
  if (!existsSync(marker)) throw new Error(`${home} exists and is not a README demo home; refusing to replace it.`);
  await rm(home, { recursive: true, force: true });
}
await mkdir(join(home, ".codemux"), { recursive: true });
await writeFile(marker, "");
// A tidy prompt for the integrated terminal recording.
await writeFile(join(home, ".bashrc"), "PS1='\\[\\e[1;32m\\]alex\\[\\e[0m\\] \\[\\e[1;34m\\]\\W\\[\\e[0m\\] $ '\nexport LS_COLORS='di=1;34'\nalias ls='ls --color=auto'\n");

Object.assign(process.env, {
  HOME: home, USER: "alex", SHELL: "/bin/bash",
  CODEMUX_DATA_DIR: join(home, ".codemux"),
  CODEMUX_WEB_PORT: port,
});

const { configureServerRuntimeEnvironment, serverRuntimeRole } = await import("../../server/runtime-role");
configureServerRuntimeEnvironment(serverRuntimeRole, process.env, process.platform);

const { createDemoProject } = await import("./demo-project");
await createDemoProject(project);

const { DemoEngineAdapter } = await import("./demo-engine");
const { createServiceHost } = await import("../../server/service-host");
const { scheduledTaskService } = await import("../../electron/main/services/scheduled-task-service");

const engines = {
  claude: new DemoEngineAdapter("claude"),
  copilot: new DemoEngineAdapter("copilot"),
  opencode: new DemoEngineAdapter("opencode"),
  codex: new DemoEngineAdapter("codex"),
};
const host = createServiceHost("static", undefined, {
  engines: [["Claude", engines.claude], ["Copilot", engines.copilot], ["OpenCode", engines.opencode], ["Codex", engines.codex]],
});
await host.runtime.initialize();
await host.runtime.start();
await host.runtime.completeStartup();

// History shown in the sidebar: one finished conversation per engine, played instantly.
const history: Array<[keyof typeof engines, string]> = [
  ["codex", "Bump TypeScript to 5.9 and fix any type errors"],
  ["opencode", "Write unit tests for CartSummary"],
  ["copilot", "How does checkout work in this repo?"],
  ["claude", "Add input validation to the create order API"],
];
for (const [engine, prompt] of history) {
  engines[engine].speed = 0.6;
  const session = await host.engineManager.createSession(engine, project);
  await host.engineManager.sendMessage(session.id, [{ type: "text", text: prompt }]);
  engines[engine].speed = Number(process.env.DEMO_SPEED ?? 1);
}

for (const task of [
  { name: "Morning code review", description: "Review yesterday's commits", prompt: "Review the commits from the last 24 hours and list risky changes.", engineType: "claude", frequency: { type: "daily", hour: 9, minute: 0 } },
  { name: "Dependency check", description: "Weekly outdated and audit report", prompt: "Run npm outdated and npm audit, then summarize what to upgrade.", engineType: "copilot", frequency: { type: "weekly", hour: 10, minute: 0, daysOfWeek: [1] } },
  { name: "Flaky test watch", description: "Re-run the suite and report flakes", prompt: "Run the test suite three times and report any test that fails intermittently.", engineType: "opencode", frequency: { type: "interval", intervalMinutes: 120 } },
] as const) {
  scheduledTaskService.create({ ...task, directory: project, frequency: { ...task.frequency } as never });
}

// Remote devices for the Devices page (the local browser registers itself as the host).
const { deviceStore } = await import("../../electron/main/services/device-store");
const now = Date.now();
for (const [name, platform, browser, ip, ageMin] of [
  ["Alex's iPhone", "iOS", "Safari", "192.168.1.24", 3],
  ["iPad Air", "iPadOS", "Safari", "192.168.1.31", 95],
  ["Work laptop", "Windows", "Edge", "104.28.12.7", 60 * 26],
] as const) {
  deviceStore.addDevice({ id: deviceStore.generateDeviceId(), name, platform, browser, ip,
    createdAt: now - 1000 * 60 * 60 * 24 * 9, lastSeenAt: now - ageMin * 60_000 });
}

console.log(JSON.stringify({ type: "demo.ready", url: `http://127.0.0.1:${port}`, project, home }));

const stop = async () => {
  await host.stop().catch(() => {});
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
