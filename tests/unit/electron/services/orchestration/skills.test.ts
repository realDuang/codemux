import { describe, it, expect } from "vitest";
import {
  extractJsonBlocks,
  parseFirstJson,
  dagPlanningSkill,
  dispatchSkill,
  executeWithSkill,
} from "../../../../../electron/main/services/orchestration/skills";

// =============================================================================
// extractJsonBlocks
// =============================================================================

describe("extractJsonBlocks", () => {
  it("extracts JSON from ```json fenced block", () => {
    const text = 'Here is the plan:\n```json\n{"tasks": []}\n```\nDone.';
    const blocks = extractJsonBlocks(text);
    expect(blocks).toEqual(['{"tasks": []}']);
  });

  it("extracts JSON from ``` fenced block (no json tag)", () => {
    const text = "```\n{\"action\": \"complete\"}\n```";
    const blocks = extractJsonBlocks(text);
    expect(blocks).toEqual(['{"action": "complete"}']);
  });

  it("extracts multiple fenced blocks", () => {
    const text = "```json\n{\"a\":1}\n```\ntext\n```json\n{\"b\":2}\n```";
    const blocks = extractJsonBlocks(text);
    expect(blocks).toHaveLength(2);
  });

  it("falls back to bare JSON when no fences", () => {
    const text = 'The result is {"tasks": [{"id": "t1"}]}';
    const blocks = extractJsonBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(JSON.parse(blocks[0])).toEqual({ tasks: [{ id: "t1" }] });
  });

  it("returns empty for no JSON", () => {
    const text = "No JSON here, just text.";
    expect(extractJsonBlocks(text)).toEqual([]);
  });

  it("handles multiline JSON in fenced block", () => {
    const text = '```json\n{\n  "tasks": [\n    {\n      "id": "t1",\n      "description": "test"\n    }\n  ]\n}\n```';
    const blocks = extractJsonBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(JSON.parse(blocks[0]).tasks[0].id).toBe("t1");
  });
});

// =============================================================================
// parseFirstJson
// =============================================================================

describe("parseFirstJson", () => {
  it("parses valid JSON from fenced block", () => {
    const text = '```json\n{"key": "value"}\n```';
    const result = parseFirstJson<{ key: string }>(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.key).toBe("value");
  });

  it("returns error for no JSON", () => {
    const result = parseFirstJson("No JSON here");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No JSON block found");
  });

  it("returns error for invalid JSON syntax", () => {
    const text = '```json\n{invalid json}\n```';
    const result = parseFirstJson(text);
    expect(result.ok).toBe(false);
  });
});

// =============================================================================
// dagPlanningSkill.parse
// =============================================================================

describe("dagPlanningSkill.parse", () => {
  it("parses valid DAG", () => {
    const text = `\`\`\`json
{
  "tasks": [
    {
      "id": "t1",
      "description": "Analyze code",
      "prompt": "Read and analyze the codebase",
      "dependsOn": []
    },
    {
      "id": "t2",
      "description": "Implement changes",
      "prompt": "Make the changes based on analysis",
      "dependsOn": ["t1"]
    }
  ]
}
\`\`\``;
    const result = dagPlanningSkill.parse(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.tasks).toHaveLength(2);
      expect(result.data.tasks[0].id).toBe("t1");
      expect(result.data.tasks[1].dependsOn).toEqual(["t1"]);
    }
  });

  it("rejects empty tasks array", () => {
    const text = '```json\n{"tasks": []}\n```';
    const result = dagPlanningSkill.parse(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("empty");
  });

  it("rejects duplicate task IDs", () => {
    const text = `\`\`\`json
{"tasks": [
  {"id": "t1", "description": "A", "prompt": "Do A", "dependsOn": []},
  {"id": "t1", "description": "B", "prompt": "Do B", "dependsOn": []}
]}
\`\`\``;
    const result = dagPlanningSkill.parse(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("duplicate");
  });

  it("rejects missing fields", () => {
    const text = '```json\n{"tasks": [{"id": "t1"}]}\n```';
    const result = dagPlanningSkill.parse(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("description");
      expect(result.error).toContain("prompt");
    }
  });

  it("rejects unknown dependency reference", () => {
    const text = `\`\`\`json
{"tasks": [
  {"id": "t1", "description": "A", "prompt": "Do A", "dependsOn": ["t99"]}
]}
\`\`\``;
    const result = dagPlanningSkill.parse(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("t99");
  });

  it("rejects circular dependencies", () => {
    const text = `\`\`\`json
{"tasks": [
  {"id": "t1", "description": "A", "prompt": "Do A", "dependsOn": ["t2"]},
  {"id": "t2", "description": "B", "prompt": "Do B", "dependsOn": ["t1"]}
]}
\`\`\``;
    const result = dagPlanningSkill.parse(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Circular");
  });

  it("rejects DAG with no root", () => {
    const text = `\`\`\`json
{"tasks": [
  {"id": "t1", "description": "A", "prompt": "Do A", "dependsOn": ["t2"]},
  {"id": "t2", "description": "B", "prompt": "Do B", "dependsOn": ["t3"]},
  {"id": "t3", "description": "C", "prompt": "Do C", "dependsOn": ["t1"]}
]}
\`\`\``;
    const result = dagPlanningSkill.parse(text);
    expect(result.ok).toBe(false);
  });

  it("accepts optional engineType field", () => {
    const text = `\`\`\`json
{"tasks": [
  {"id": "t1", "description": "A", "prompt": "Do A", "dependsOn": [], "engineType": "claude"}
]}
\`\`\``;
    const result = dagPlanningSkill.parse(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.tasks[0].engineType).toBe("claude");
  });

  it("accepts optional worktreeId field", () => {
    const text = `\`\`\`json
{"tasks": [
  {"id": "t1", "description": "A", "prompt": "Do A", "dependsOn": [], "worktreeId": "feature-branch"}
]}
\`\`\``;
    const result = dagPlanningSkill.parse(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.tasks[0].worktreeId).toBe("feature-branch");
  });

  it("rejects invalid worktreeId field", () => {
    const text = `\`\`\`json
{"tasks": [
  {"id": "t1", "description": "A", "prompt": "Do A", "dependsOn": [], "worktreeId": 123}
]}
\`\`\``;
    const result = dagPlanningSkill.parse(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("worktreeId");
  });
});

// =============================================================================
// dispatchSkill.parse
// =============================================================================

describe("dispatchSkill.parse", () => {
  it("parses dispatch instruction", () => {
    const text = `\`\`\`json
{
  "action": "dispatch",
  "tasks": [
    {"id": "t1", "description": "Analyze", "prompt": "Analyze the code"}
  ]
}
\`\`\``;
    const result = dispatchSkill.parse(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe("dispatch");
      if (result.data.action === "dispatch") {
        expect(result.data.tasks).toHaveLength(1);
      }
    }
  });

  it("parses complete instruction", () => {
    const text = '```json\n{"action": "complete", "result": "All tasks done successfully."}\n```';
    const result = dispatchSkill.parse(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe("complete");
      if (result.data.action === "complete") {
        expect(result.data.result).toBe("All tasks done successfully.");
      }
    }
  });

  it("rejects unknown action", () => {
    const text = '```json\n{"action": "unknown"}\n```';
    const result = dispatchSkill.parse(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unknown action");
  });

  it("rejects dispatch with empty tasks", () => {
    const text = '```json\n{"action": "dispatch", "tasks": []}\n```';
    const result = dispatchSkill.parse(text);
    expect(result.ok).toBe(false);
  });

  it("rejects complete without result", () => {
    const text = '```json\n{"action": "complete"}\n```';
    const result = dispatchSkill.parse(text);
    expect(result.ok).toBe(false);
  });

  it("rejects dispatch task missing required fields", () => {
    const text = '```json\n{"action": "dispatch", "tasks": [{"id": "t1"}]}\n```';
    const result = dispatchSkill.parse(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("description");
  });

  it("accepts optional dispatch worktreeId field", () => {
    const text = `\`\`\`json
{
  "action": "dispatch",
  "tasks": [
    {"id": "t1", "description": "Analyze", "prompt": "Analyze the code", "worktreeId": "feature-branch"}
  ]
}
\`\`\``;
    const result = dispatchSkill.parse(text);
    expect(result.ok).toBe(true);
    if (result.ok && result.data.action === "dispatch") {
      expect(result.data.tasks[0].worktreeId).toBe("feature-branch");
    }
  });

  it("rejects invalid dispatch worktreeId field", () => {
    const text = '```json\n{"action": "dispatch", "tasks": [{"id": "t1", "description": "Analyze", "prompt": "Analyze the code", "worktreeId": 42}]}\n```';
    const result = dispatchSkill.parse(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("worktreeId");
  });
});

// =============================================================================
// correctionPrompt
// =============================================================================

describe("correctionPrompt", () => {
  it("dagPlanningSkill generates correction", () => {
    const correction = dagPlanningSkill.correctionPrompt("bad output", "Missing tasks array");
    expect(correction).toContain("Missing tasks array");
    expect(correction).toContain("corrected JSON");
  });

  it("dispatchSkill generates correction", () => {
    const correction = dispatchSkill.correctionPrompt("bad output", "Unknown action");
    expect(correction).toContain("Unknown action");
    expect(correction).toContain("corrected JSON");
  });
});

// =============================================================================
// executeWithSkill
// =============================================================================

describe("executeWithSkill", () => {
  it("succeeds on first attempt with valid output", async () => {
    const sendMessage = async (_text: string) =>
      '```json\n{"tasks": [{"id": "t1", "description": "test", "prompt": "do it", "dependsOn": []}]}\n```';

    const result = await executeWithSkill(sendMessage, "user request", dagPlanningSkill);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.tasks).toHaveLength(1);
  });

  it("retries on first failure and succeeds", async () => {
    let callCount = 0;
    const sendMessage = async (_text: string) => {
      callCount++;
      if (callCount === 1) return "not json";
      return '```json\n{"tasks": [{"id": "t1", "description": "test", "prompt": "do it", "dependsOn": []}]}\n```';
    };

    const result = await executeWithSkill(sendMessage, "user request", dagPlanningSkill);
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  it("fails after max retries", async () => {
    const sendMessage = async (_text: string) => "still not json";

    const result = await executeWithSkill(sendMessage, "user request", dagPlanningSkill, 1);
    expect(result.ok).toBe(false);
  });

  it("includes format prompt in first message", async () => {
    let receivedPrompt = "";
    const sendMessage = async (text: string) => {
      receivedPrompt = text;
      return '```json\n{"tasks": [{"id": "t1", "description": "test", "prompt": "do it", "dependsOn": []}]}\n```';
    };

    await executeWithSkill(sendMessage, "my request", dagPlanningSkill);
    expect(receivedPrompt).toContain("Self-Check Before Outputting");
    expect(receivedPrompt).toContain("my request");
  });
});
