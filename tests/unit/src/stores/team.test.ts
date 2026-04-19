import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMock = vi.hoisted(() => ({
  createTeamRun: vi.fn(),
  cancelTeamRun: vi.fn(),
  sendTeamMessage: vi.fn(),
}));

const { storeContainer } = vi.hoisted(() => {
  const storeContainer: { data: any; setter: any } = { data: {}, setter: null };
  return { storeContainer };
});

vi.mock("../../../../src/lib/gateway-api", () => ({
  gateway: gatewayMock,
}));

vi.mock("solid-js/store", () => ({
  createStore: vi.fn((initial: any) => {
    Object.keys(storeContainer.data).forEach((key) => delete storeContainer.data[key]);
    Object.assign(storeContainer.data, initial);

    storeContainer.setter = (pathOrValue: any, ...args: any[]) => {
      if (args.length === 0) {
        Object.keys(storeContainer.data).forEach((key) => delete storeContainer.data[key]);
        Object.assign(storeContainer.data, pathOrValue);
        return;
      }

      if (args.length === 1) {
        const next = typeof args[0] === "function"
          ? args[0](storeContainer.data[pathOrValue])
          : args[0];
        storeContainer.data[pathOrValue] = next;
        return;
      }

      if (!storeContainer.data[pathOrValue] || typeof storeContainer.data[pathOrValue] !== "object") {
        storeContainer.data[pathOrValue] = {};
      }
      storeContainer.data[pathOrValue] = {
        ...storeContainer.data[pathOrValue],
        [args[0]]: args[1],
      };
    };

    return [storeContainer.data, storeContainer.setter];
  }),
}));

import type { TeamRun } from "../../../../src/types/unified";
import {
  connectTeamHandlers,
  getActiveHeavyTeamRunForSession,
  getActiveTeamRunForSession,
  getTeamRunForSession,
  getTeamRunsForSession,
  hydrateTeamRuns,
  sendTeamRunMessage,
  teamStore,
} from "../../../../src/stores/team";

function makeRun(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    id: "team-1",
    parentSessionId: "session-1",
    directory: "/repo",
    originalPrompt: "Investigate issue",
    mode: "heavy",
    status: "completed",
    tasks: [],
    time: { created: 1 },
    ...overrides,
  };
}

describe("team store selectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    teamStore.runs.splice(0, teamStore.runs.length);
    teamStore.activeRunId = null;
  });

  describe("getTeamRunForSession", () => {
    it("prefers an active run over a newer completed run", () => {
      const handlers = connectTeamHandlers();
      const activeRun = makeRun({
        id: "team-active",
        status: "running",
        time: { created: 10 },
      });
      const completedRun = makeRun({
        id: "team-complete",
        status: "completed",
        time: { created: 20 },
      });

      handlers.onTeamRunUpdated(completedRun);
      handlers.onTeamRunUpdated(activeRun);

      expect(getTeamRunForSession("session-1")?.id).toBe("team-active");
    });

    it("falls back to the newest run when none are active", () => {
      const handlers = connectTeamHandlers();
      handlers.onTeamRunUpdated(makeRun({ id: "team-old", time: { created: 10 } }));
      handlers.onTeamRunUpdated(makeRun({ id: "team-new", time: { created: 20 } }));

      expect(getTeamRunForSession("session-1")?.id).toBe("team-new");
    });
  });

  describe("active team run helpers", () => {
    it("returns the active run for the session", () => {
      const handlers = connectTeamHandlers();
      handlers.onTeamRunUpdated(makeRun({ id: "team-complete", status: "completed" }));
      handlers.onTeamRunUpdated(
        makeRun({ id: "team-light", mode: "light", status: "planning", time: { created: 5 } }),
      );

      expect(getActiveTeamRunForSession("session-1")?.id).toBe("team-light");
    });

    it("returns only active heavy runs for orchestrator relays", () => {
      const handlers = connectTeamHandlers();
      handlers.onTeamRunUpdated(
        makeRun({ id: "team-light", mode: "light", status: "running", time: { created: 30 } }),
      );
      handlers.onTeamRunUpdated(
        makeRun({ id: "team-heavy-old", mode: "heavy", status: "completed", time: { created: 40 } }),
      );
      handlers.onTeamRunUpdated(
        makeRun({ id: "team-heavy-active", mode: "heavy", status: "running", time: { created: 20 } }),
      );

      expect(getActiveHeavyTeamRunForSession("session-1")?.id).toBe("team-heavy-active");
    });

    it("returns all runs sorted by activity first, then newest first", () => {
      const handlers = connectTeamHandlers();
      handlers.onTeamRunUpdated(
        makeRun({ id: "team-complete-new", status: "completed", time: { created: 30 } }),
      );
      handlers.onTeamRunUpdated(
        makeRun({ id: "team-active", status: "running", time: { created: 10 } }),
      );
      handlers.onTeamRunUpdated(
        makeRun({ id: "team-complete-old", status: "completed", time: { created: 20 } }),
      );

      expect(getTeamRunsForSession("session-1").map((run) => run.id)).toEqual([
        "team-active",
        "team-complete-new",
        "team-complete-old",
      ]);
    });
  });

  describe("hydrateTeamRuns", () => {
    it("replaces the known runs with a backend snapshot", () => {
      hydrateTeamRuns([
        makeRun({ id: "team-old", status: "completed" }),
        makeRun({ id: "team-active", status: "running", mode: "heavy" }),
      ]);

      hydrateTeamRuns([
        makeRun({ id: "team-restored", status: "failed", mode: "light" }),
      ]);

      expect(teamStore.runs.map((run) => run.id)).toEqual(["team-restored"]);
      expect(teamStore.activeRunId).toBeNull();
    });
  });

  describe("sendTeamRunMessage", () => {
    it("delegates to the gateway team message API", async () => {
      await sendTeamRunMessage("team-123", "Need a tighter plan");

      expect(gatewayMock.sendTeamMessage).toHaveBeenCalledWith("team-123", "Need a tighter plan");
    });
  });
});
