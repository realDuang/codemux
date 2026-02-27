// ============================================================================
// E2E Seed Data — Pre-built test fixtures for integration/E2E tests
// ============================================================================

import type {
  UnifiedSession,
  UnifiedMessage,
  TextPart,
} from "../../../src/types/unified";
import type { MockEngineAdapter } from "../../../electron/main/engines/mock-adapter";

// --- Test projects ---

export const TEST_PROJECTS = {
  project1: {
    directory: "/test/project-alpha",
    engineType: "opencode" as const,
  },
  project2: {
    directory: "/test/project-beta",
    engineType: "copilot" as const,
  },
  // Same path as project1 but different engine — tests cross-engine dedup
  project3: {
    directory: "/test/project-alpha",
    engineType: "copilot" as const,
  },
};

// --- Pre-built sessions ---

export const TEST_SESSIONS: UnifiedSession[] = [
  // Project 1 (opencode): 2 sessions
  {
    id: "session-oc-1",
    engineType: "opencode",
    directory: "/test/project-alpha",
    title: "Fix authentication bug",
    time: { created: Date.now() - 3600000, updated: Date.now() - 1800000 },
  },
  {
    id: "session-oc-2",
    engineType: "opencode",
    directory: "/test/project-alpha",
    title: "Add unit tests",
    time: { created: Date.now() - 7200000, updated: Date.now() - 3600000 },
  },
  {
    id: "session-oc-3",
    engineType: "opencode",
    directory: "/test/project-alpha",
    title: "Improve error handling",
    time: { created: Date.now() - 5400000, updated: Date.now() - 2700000 },
  },
  // Project 2 (copilot): 1 session
  {
    id: "session-cp-1",
    engineType: "copilot",
    directory: "/test/project-beta",
    title: "Refactor database layer",
    time: { created: Date.now() - 1800000, updated: Date.now() - 900000 },
  },
  // Project 3 (copilot, same path as project1): 1 session
  {
    id: "session-cp-2",
    engineType: "copilot",
    directory: "/test/project-alpha",
    title: "Cross-engine test session",
    time: { created: Date.now() - 1200000, updated: Date.now() - 600000 },
  },
];

// --- Pre-built messages ---

export const TEST_MESSAGES: Record<string, UnifiedMessage[]> = {
  // session-oc-1: full conversation (user + assistant)
  "session-oc-1": [
    {
      id: "msg-1",
      sessionId: "session-oc-1",
      role: "user",
      time: { created: Date.now() - 3500000 },
      parts: [
        {
          id: "part-1",
          messageId: "msg-1",
          sessionId: "session-oc-1",
          type: "text",
          text: "Fix the login bug",
        } as TextPart,
      ],
    },
    {
      id: "msg-2",
      sessionId: "session-oc-1",
      role: "assistant",
      time: { created: Date.now() - 3400000, completed: Date.now() - 3300000 },
      parts: [
        {
          id: "part-2",
          messageId: "msg-2",
          sessionId: "session-oc-1",
          type: "text",
          text: "I found the issue in the auth middleware. The token validation was skipping expiry checks.",
        } as TextPart,
      ],
      tokens: { input: 150, output: 45 },
      modelId: "mock/test-model",
    },
  ],

  // session-oc-2: empty (no messages yet)
  "session-oc-2": [],

  // session-oc-3: empty (no messages yet)
  "session-oc-3": [],

  // session-cp-1: one user message, no response yet
  "session-cp-1": [
    {
      id: "msg-3",
      sessionId: "session-cp-1",
      role: "user",
      time: { created: Date.now() - 1700000 },
      parts: [
        {
          id: "part-3",
          messageId: "msg-3",
          sessionId: "session-cp-1",
          type: "text",
          text: "Refactor the database connection pool",
        } as TextPart,
      ],
    },
  ],

  // session-cp-2: one user message
  "session-cp-2": [
    {
      id: "msg-4",
      sessionId: "session-cp-2",
      role: "user",
      time: { created: Date.now() - 1100000 },
      parts: [
        {
          id: "part-4",
          messageId: "msg-4",
          sessionId: "session-cp-2",
          type: "text",
          text: "Test cross-engine project setup",
        } as TextPart,
      ],
    },
  ],
};

// --- Seeding helper ---

/**
 * Populate mock adapters with pre-built sessions and messages.
 * Call this after startTestServer() to set up a realistic initial state.
 */
export function seedTestData(adapters: Map<string, MockEngineAdapter>): void {
  for (const session of TEST_SESSIONS) {
    const adapter = adapters.get(session.engineType);
    if (adapter) {
      const messages = TEST_MESSAGES[session.id] || [];
      adapter.seedSession(session, messages);
    }
  }
}
