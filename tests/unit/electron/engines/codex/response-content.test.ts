import { describe, expect, it } from "vitest";
import { normalizeCodexResponseContent } from "../../../../../electron/main/engines/codex/response-content";

const metadata = `<oai-mem-citation>
<citation_entries>
MEMORY.md:10-12|note=[Used the project conventions]
rollout_summaries/session.md:5-8|note=[Kept the existing behavior]
</citation_entries>
<rollout_ids>
019c6e27-e55b-73d1-87d8-4e01f1f75043
</rollout_ids>
</oai-mem-citation>`;

describe("normalizeCodexResponseContent", () => {
  it("normalizes structured source notes while retaining the wire text", () => {
    const normalized = normalizeCodexResponseContent("The answer.", {
      entries: [
        { path: "MEMORY.md", lineStart: 10, lineEnd: 12, note: " Project conventions " },
        { path: "MEMORY.md", lineStart: 10, lineEnd: 12, note: " Project conventions " },
        { path: "empty.md", lineStart: 1, lineEnd: 2, note: " " },
        null,
      ],
      threadIds: ["private-session-id"],
    });

    expect(normalized).toEqual({
      text: "The answer.", displayText: undefined,
      citations: [{ note: "Project conventions", reference: "MEMORY.md:10-12" }],
    });
  });

  it("separates legacy trailing metadata without displaying source paths or thread IDs as prose", () => {
    const text = `The answer.\n\n${metadata}\n`;
    const normalized = normalizeCodexResponseContent(text);

    expect(normalized.text).toBe(text);
    expect(normalized.displayText).toBe("The answer.");
    expect(normalized.citations).toEqual([
      { note: "Used the project conventions", reference: "MEMORY.md:10-12" },
      { note: "Kept the existing behavior", reference: "rollout_summaries/session.md:5-8" },
    ]);
  });

  it("keeps the visible answer stable as the trailing metadata arrives in pieces", () => {
    for (const end of [9, 14, 18, 50, metadata.length - 5, metadata.length]) {
      const text = `The answer.\n\n${metadata.slice(0, end)}`;
      const normalized = normalizeCodexResponseContent(text);
      expect(normalized.text).toBe(text);
      expect(normalized.displayText).toBe("The answer.");
    }
  });

  it.each([
    `Example: ${metadata}`,
    `\`\`\`xml\n${metadata}\n\`\`\``,
    `~~~xml\n${metadata}\n~~~`,
    `${metadata}\nThis text follows the example.`,
    "Before\n<oai-mem-cit\nAfter",
    `Example:\n\n${metadata.split("\n").map((line) => `    ${line}`).join("\n")}`,
    `Before\n\`\`\`\ncode\n\`\`\` not a closing fence\n${metadata}`,
  ])("preserves literal citation examples that are not trailing metadata", (text) => {
    expect(normalizeCodexResponseContent(text)).toEqual({ text, displayText: undefined, citations: undefined });
  });

  it("prefers structured entries when both transports supply the citation", () => {
    expect(normalizeCodexResponseContent(`Answer\n${metadata}`, {
      entries: [{ note: "Authoritative source", path: "current.md", lineStart: 1, lineEnd: 2 }],
    }).citations).toEqual([{ note: "Authoritative source", reference: "current.md:1-2" }]);
  });

  it("clears stale display metadata after authoritative text replacement", () => {
    const streamed = normalizeCodexResponseContent(`Answer\n${metadata}`);
    const replaced = { ...streamed, ...normalizeCodexResponseContent("Revised answer") };

    expect(replaced).toEqual({ text: "Revised answer", displayText: undefined, citations: undefined });
  });
});


describe("async question display", () => {
  it("preserves raw text while displaying typed question titles and options", () => {
    const result = normalizeCodexResponseContent("Choose a direction.", null, [{ title: "Which [target]?", options: ["First", "Second"] }]);
    expect(result.text).toBe("Choose a direction.");
    expect(result.displayText).toContain("Which \\[target\\]?");
    expect(result.displayText).toContain("- First\n- Second");
  });
});
