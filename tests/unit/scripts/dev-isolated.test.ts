import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPortPlan, resolveSpawnTarget } from "../../../scripts/dev-isolated";

describe("dev-isolated script", () => {
  it("builds an offset port plan", () => {
    const plan = buildPortPlan(200, {});

    expect(plan).toEqual({
      portOffset: 200,
      ports: {
        web: 8433,
        webStandalone: 8434,
        gateway: 4400,
        opencode: 4296,
        authApi: 4297,
        webhook: 4298,
      },
    });
  });

  it("keeps explicit port overrides in the plan", () => {
    const plan = buildPortPlan(200, {
      CODEMUX_WEB_PORT: "9100",
      CODEMUX_OPENCODE_PORT: "9101",
    });

    expect(plan.ports.web).toBe(9100);
    expect(plan.ports.opencode).toBe(9101);
    expect(plan.ports.gateway).toBe(4400);
  });

  it("throws for offsets that would create invalid default ports", () => {
    expect(() => buildPortPlan(60_000, {})).toThrow("CODEMUX_PORT_OFFSET must be between 0");
  });

  it("throws when an explicit override duplicates another service port", () => {
    expect(() => buildPortPlan(200, {
      CODEMUX_WEB_PORT: "9100",
      CODEMUX_GATEWAY_PORT: "9100",
    })).toThrow("CODEMUX_GATEWAY_PORT and CODEMUX_WEB_PORT both resolve to port 9100");
  });
});

describe("resolveSpawnTarget", () => {
  const projectRoot = "/repo";

  it("defaults to `bun run dev` when no --server flag is passed", () => {
    expect(resolveSpawnTarget([], projectRoot)).toEqual({
      cmd: "bun",
      args: ["run", "dev"],
    });
  });

  it("switches to the headless server wrapper when --server is present", () => {
    expect(resolveSpawnTarget(["--server"], projectRoot)).toEqual({
      cmd: "bash",
      args: [path.join("/repo", "scripts/server-dev.sh"), "start", "--foreground"],
    });
  });

  it("ignores unrelated args in the dev path", () => {
    expect(resolveSpawnTarget(["--", "--unused-flag"], projectRoot)).toEqual({
      cmd: "bun",
      args: ["run", "dev"],
    });
  });

  it("composes the server-dev.sh path relative to the supplied project root", () => {
    const target = resolveSpawnTarget(["--server"], "/some/other/root");
    expect(target.args[0]).toBe(path.join("/some/other/root", "scripts/server-dev.sh"));
  });
});
