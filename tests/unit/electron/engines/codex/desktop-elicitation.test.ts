import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildDesktopElicitationResponse,
  cancelDesktopElicitation,
  convertDesktopElicitationToQuestion,
} from "../../../../../electron/main/engines/codex/desktop-elicitation";
import { CodexDesktopAdapter } from "../../../../../electron/main/engines/codex/desktop-adapter";
import type { CodexDesktopIpcClient, DesktopThreadSnapshot } from "../../../../../electron/main/engines/codex/desktop-ipc-client";
import { desktopRequestId } from "../../../../../electron/main/engines/codex/desktop-state";

function request(properties: Record<string, unknown>, required: string[] = []) {
  return { mode: "form", serverName: "fixture-mcp", message: "Provide the test values.", requestedSchema: { type: "object", properties, required, additionalProperties: false } };
}

describe("convertDesktopElicitationToQuestion", () => {
  it("offers action and schema fields without changing native identity", () => {
    const question = convertDesktopElicitationToQuestion("thread", 42, request({ enabled: { type: "boolean" }, count: { type: "integer" } }, ["enabled"]));
    expect(question).toMatchObject({ id: "42", sessionId: "thread", engineType: "codex-desktop", dismissStopsTurn: false });
    expect(question.questions.map((entry) => entry.options.map((option) => option.label))).toEqual([["Accept", "Decline", "Cancel"], ["True", "False"], []]);
    expect(question.questions[1]).toMatchObject({ custom: false, multiple: false });
    expect(question.questions[2]).toMatchObject({ custom: true, multiple: false });
  });

  it("preserves custom string whitespace and distinguishes required empty values", () => {
    const params = request({ required: { type: "string" }, optional: { type: "string" }, constrained: { type: "string", minLength: 1 } }, ["required", "constrained"]);
    const question = convertDesktopElicitationToQuestion("thread", "request", params);
    expect(question.questions[1]).toMatchObject({ preserveWhitespace: true, allowEmptyAnswer: true });
    expect(question.questions[2]).toMatchObject({ preserveWhitespace: true });
    expect(question.questions[2].allowEmptyAnswer).toBeUndefined();
    expect(buildDesktopElicitationResponse(params, [["Accept"], [""], [], [" keep spaces "]]).content).toEqual({ required: "", constrained: " keep spaces " });
    expect(() => buildDesktopElicitationResponse(params, [["Accept"], [""], [], [""]])).toThrow("too short");
  });

  it.each([
    { type: "object", properties: { nested: { type: "object", properties: {} } } },
    { type: "object", properties: { code: { type: "string", pattern: "^(a+)+$" } } },
    { type: "object", properties: { code: { type: "string", format: "custom-secret-format" } } },
    { type: "object", properties: { value: { type: "string", oneOf: [{ type: "string" }, { type: "null" }] } } },
    { type: "object", properties: { value: { type: "string", enum: ["a", "b"], enumNames: ["Same", "Same"] } } },
    { type: "object", properties: { value: { type: "number", minimum: null } } },
    { type: "object", properties: { value: { type: "string", maxLength: null } } },
    { type: "object", properties: { value: { type: "string", enum: null } } },
    { type: "object", properties: {}, required: null },
  ])("keeps unsupported schemas visible with only decline and cancel", (requestedSchema) => {
    const params = { mode: "form", serverName: "fixture-mcp", requestedSchema };
    const question = convertDesktopElicitationToQuestion("thread", "request", params);
    expect(question.questions).toHaveLength(1);
    expect(question.questions[0].options.map((option) => option.label)).toEqual(["Decline", "Cancel"]);
    expect(() => buildDesktopElicitationResponse(params, [["Accept"]])).toThrow("original Codex client");
    expect(buildDesktopElicitationResponse(params, [["Cancel"]])).toEqual({ action: "cancel", content: null, _meta: null });
  });

  it("uses native requestedSchema casing and rejects prototype-related fields", () => {
    const params = { mode: "form", requestSchema: { type: "object", properties: {} } };
    expect(convertDesktopElicitationToQuestion("thread", "request", params).metadata?.supportedForm).toBe(false);
    const properties = JSON.parse('{"__proto__":{"type":"string"}}') as Record<string, unknown>;
    expect(convertDesktopElicitationToQuestion("thread", "request", request(properties)).metadata?.supportedForm).toBe(false);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("exposes only user-gesture-safe external links", () => {
    const params = { mode: "url", serverName: "fixture-mcp", message: "Complete the external flow.", url: "https://example.test/authorize" };
    const question = convertDesktopElicitationToQuestion("thread", "request", params);
    expect(question.externalUrl).toBe("https://example.test/authorize");
    expect(buildDesktopElicitationResponse(params, [["Accept"]])).toEqual({ action: "accept", content: {}, _meta: null });
    for (const url of ["javascript:alert(1)", "file:///tmp/fixture", "https://name:password@example.test/"]) {
      const unsupported = convertDesktopElicitationToQuestion("thread", "request", { ...params, url });
      expect(unsupported.externalUrl).toBeUndefined();
      expect(unsupported.questions[0].options.map((option) => option.label)).toEqual(["Decline", "Cancel"]);
    }
  });

  it.each([
    { mode: "openai/userVerification" },
    { mode: "openai/form" },
    { mode: "form", _meta: { codex_approval_kind: "browser_auth" }, requestedSchema: { type: "object", properties: {} } },
  ])("does not offer generic acceptance for specialized authorization", (params) => {
    expect(convertDesktopElicitationToQuestion("thread", "request", params).questions[0].options.map((option) => option.label)).toEqual(["Decline", "Cancel"]);
    expect(() => buildDesktopElicitationResponse(params, [["Accept"]])).toThrow();
  });
});

describe("buildDesktopElicitationResponse", () => {
  it("preserves primitive and enum-array types and omits optional blanks", () => {
    const params = request({
      name: { type: "string", minLength: 1, maxLength: 10 },
      enabled: { type: "boolean" },
      count: { type: "integer", minimum: 1, maximum: 5 },
      rate: { type: "number", exclusiveMinimum: 0, maximum: 1, multipleOf: 0.1 },
      level: { type: "integer", enum: [1, 2], enumNames: ["Basic", "Advanced"] },
      tags: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { type: "string", oneOf: [{ const: "one", title: "First" }, { const: "two", title: "Second" }] } },
      optional: { type: "string" },
    }, ["name", "enabled", "count", "rate", "tags"]);
    expect(buildDesktopElicitationResponse(params, [["Accept"], ["Alice"], ["False"], ["3"], ["0.3"], ["Advanced"], ["First", "Second"], [""]])).toEqual({
      action: "accept", content: { name: "Alice", enabled: false, count: 3, rate: 0.3, level: 2, tags: ["one", "two"] }, _meta: null,
    });
  });

  it("keeps an explicitly selected empty-string enum value", () => {
    const params = request({ value: { type: "string", enum: ["", "other"] } });
    expect(buildDesktopElicitationResponse(params, [["Accept"], ["(empty string)"]]).content).toEqual({ value: "" });
  });

  it.each(["NaN", "Infinity", "1e999", "0x20", "1.5", "9007199254740993", "6"])("rejects invalid integer value %s", (value) => {
    const params = request({ count: { type: "integer", minimum: 1, maximum: 5 } }, ["count"]);
    expect(() => buildDesktopElicitationResponse(params, [["Accept"], [value]])).toThrow();
  });

  it("validates required values, numeric bounds, Unicode lengths, and enum labels", () => {
    expect(() => buildDesktopElicitationResponse(request({ name: { type: "string" } }, ["name"]), [["Accept"]])).toThrow("required");
    expect(() => buildDesktopElicitationResponse(request({ flag: { type: "boolean" } }), [["Accept"], ["truthy"]])).toThrow("offered");
    expect(() => buildDesktopElicitationResponse(request({ rate: { type: "number", exclusiveMinimum: 0, maximum: 1, multipleOf: 0.1 } }), [["Accept"], ["0.35"]])).toThrow("multiple");
    expect(() => buildDesktopElicitationResponse(request({ rate: { type: "number", exclusiveMinimum: 0 } }), [["Accept"], ["0"]])).toThrow("range");
    expect(buildDesktopElicitationResponse(request({ text: { type: "string", minLength: 1, maxLength: 1 } }), [["Accept"], ["🐦"]]).content).toEqual({ text: "🐦" });
    expect(() => buildDesktopElicitationResponse(request({ text: { type: "string", maxLength: 1 } }), [["Accept"], ["🐦🐦"]])).toThrow("long");
  });

  it("validates array selection count and uniqueness", () => {
    const params = request({ values: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { type: "string", enum: ["a", "b", "c"] } } }, ["values"]);
    expect(() => buildDesktopElicitationResponse(params, [["Accept"], []])).toThrow("Select more");
    expect(() => buildDesktopElicitationResponse(params, [["Accept"], ["a", "a"]])).toThrow("Duplicate");
    expect(() => buildDesktopElicitationResponse(params, [["Accept"], ["a", "b", "c"]])).toThrow("Too many");
  });

  it.each([
    ["email", "person@example.test", "person..name@example.test"],
    ["uri", "https://example.test/path", "https://example.test/%xx"],
    ["date", "2024-02-29", "2023-02-29"],
    ["date-time", "2026-10-13T01:02:03+08:00", "2026-10-13T25:02:03Z"],
  ])("checks %s format", (format, valid, invalid) => {
    const params = request({ value: { type: "string", format } });
    expect(buildDesktopElicitationResponse(params, [["Accept"], [valid]]).content).toEqual({ value: valid });
    expect(() => buildDesktopElicitationResponse(params, [["Accept"], [invalid]])).toThrow("format");
  });

  it("requires one known action and keeps cancellation independent of form values", () => {
    const params = request({ count: { type: "integer" } }, ["count"]);
    expect(() => buildDesktopElicitationResponse(params, [])).toThrow("action");
    expect(() => buildDesktopElicitationResponse(params, [["Accept", "Decline"]])).toThrow("action");
    expect(buildDesktopElicitationResponse(params, [["Decline"]])).toEqual({ action: "decline", content: null, _meta: null });
    expect(cancelDesktopElicitation()).toEqual({ action: "cancel", content: null, _meta: null });
  });
});

class ElicitationClient extends EventEmitter {
  connected = true;
  revision = 1;
  state = {
    id: "thread", hostId: "local", cwd: "/fixture", resumeState: "resumed", createdAt: 1, updatedAt: 2,
    latestModel: "fixture-model", modelProvider: "fixture", latestCollaborationMode: { mode: "default", settings: { model: "fixture-model" } },
    turns: [], requests: [{ id: 7, method: "mcpServer/elicitation/request", params: request({ count: { type: "integer", minimum: 1 }, enabled: { type: "boolean" } }, ["count"]) }],
  };
  connect = vi.fn(async () => {});
  close = vi.fn(() => { this.connected = false; this.emit("close"); });
  discoverOwner = vi.fn(async () => ({ ownerClientId: "original-owner", supportsUntrustedAppInput: true }));
  followThread = vi.fn(async (): Promise<DesktopThreadSnapshot> => ({ type: "snapshot", revision: this.revision, conversationState: this.state }));
  unfollowThread = vi.fn();
  loadCompleteHistory = vi.fn(async () => ({}));
  interruptTurn = vi.fn();
  replyMcpElicitation = vi.fn(async (_thread: string, _owner: string, _id: string | number, _response: unknown) => {
    this.state = { ...this.state, requests: [] };
    this.emit("stream", { conversationId: "thread", hostId: "local", ownerClientId: "original-owner",
      change: { type: "snapshot", revision: ++this.revision, conversationState: this.state } });
  });
}

describe("Desktop elicitation adapter routing", () => {
  it("routes validated native values from state through the original owner's IPC", async () => {
    const client = new ElicitationClient();
    const adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient });
    try {
      await adapter.attachThread("thread");
      expect(adapter.getPendingQuestions("thread")[0]).toMatchObject({ id: desktopRequestId("thread", 7), dismissStopsTurn: false });
      await expect(adapter.replyQuestion(desktopRequestId("thread", 7), [["Accept"], ["invalid"], ["True"]], "thread")).rejects.toThrow();
      expect(client.replyMcpElicitation).not.toHaveBeenCalled();
      await adapter.replyQuestion(desktopRequestId("thread", 7), [["Accept"], ["3"], ["True"]], "thread");
      expect(client.replyMcpElicitation).toHaveBeenCalledExactlyOnceWith("thread", "original-owner", 7, { action: "accept", content: { count: 3, enabled: true }, _meta: null });
      expect(adapter.getPendingQuestions("thread")).toEqual([]);
      expect(client.interruptTurn).not.toHaveBeenCalled();
    } finally { await adapter.stop(); }
  });

  it("cancels an elicitation without interrupting its conversation", async () => {
    const client = new ElicitationClient();
    const adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient });
    try {
      await adapter.attachThread("thread");
      await adapter.rejectQuestion(desktopRequestId("thread", 7), "thread");
      expect(client.replyMcpElicitation).toHaveBeenCalledExactlyOnceWith("thread", "original-owner", 7, { action: "cancel", content: null, _meta: null });
      expect(client.interruptTurn).not.toHaveBeenCalled();
      expect(adapter.getPendingQuestions("thread")).toEqual([]);
    } finally { await adapter.stop(); }
  });
});
