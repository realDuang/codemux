import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { convertDesktopConversation } from "../../../../../electron/main/engines/codex/desktop-state";
import { convertThreadToMessages } from "../../../../../electron/main/engines/codex/converters";
import { withCodexAssistantImages } from "../../../../../electron/main/engines/codex/assistant-images";
import { MAX_IMAGE_SIZE_BYTES } from "../../../../../shared/image-limits";
import type { TextPart } from "../../../../../src/types/unified";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC", "base64");
let codexHome: string;
let imagePath: string;

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), "codemux-assistant-images-"));
  imagePath = join(codexHome, "visualizations", "2026", "10", "14", THREAD_ID, "preview.png");
  mkdirSync(join(imagePath, ".."), { recursive: true });
  writeFileSync(imagePath, PNG);
  vi.stubEnv("CODEX_HOME", codexHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(codexHome, { recursive: true, force: true });
});

function desktopMessage(text: string, hostId = "local", completed = true) {
  return convertDesktopConversation({
    id: THREAD_ID, hostId, cwd: join(codexHome, "project"),
    createdAt: 1000, updatedAt: 2000, resumeState: "resumed",
    turns: [{
      turnId: "turn", status: completed ? "completed" : "inProgress", turnStartedAtMs: 1000,
      ...(completed ? { durationMs: 1000 } : {}),
      items: [{ id: "reply", type: "agentMessage", phase: "final_answer", text }],
    }],
  }).messages[0];
}

function part(text = `![Preview](${imagePath})`): TextPart {
  return { id: "text", sessionId: "session", messageId: "message", type: "text", text, completed: true, phase: "final" };
}

function writeImage(...segments: string[]) {
  const path = join(codexHome, ...segments);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, PNG);
  return path;
}

describe("Codex assistant images", () => {
  it("retains the native reply while exposing its session-scoped preview to Markdown", () => {
    const text = `Updated the icon.\n\n![Icon preview](${imagePath})\n\nValidation passed.`;
    const message = desktopMessage(text);
    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]).toMatchObject({
      type: "text", text, phase: "final", completed: true,
      inlineAssets: [{ type: "file", sourcePath: imagePath, mime: "image/png", url: `data:image/png;base64,${PNG.toString("base64")}` }],
    });
  });

  it("uses the native thread identity for CLI history with a distinct unified session ID", () => {
    const text = `![Preview](${imagePath})`;
    const messages = convertThreadToMessages("unified-session", { thread: {
      id: THREAD_ID, cwd: "/project", turns: [{ id: "turn", status: "completed", items: [{ id: "reply", type: "agentMessage", text }] }],
    } });
    expect(messages[0].parts[0]).toMatchObject({ sessionId: "unified-session", text, inlineAssets: [{ sourcePath: imagePath }] });
  });

  it("keeps accepted async user answers as text without authorizing their image references", () => {
    const answer = `![Preview](${imagePath})`;
    const text = `<send_user_message_question_reply>\n${JSON.stringify([{
      questionItemId: JSON.stringify(["request_user_input_async", "question", 0]), question: "Which image?", answer,
    }])}\n</send_user_message_question_reply>`;
    const messages = convertThreadToMessages("unified-session", { thread: {
      id: THREAD_ID, cwd: "/project", turns: [{ id: "turn", status: "completed", items: [
        { id: "question", type: "agentMessage", questions: [{ title: "Which image?" }] },
        { id: "reply", type: "userMessage", content: [{ type: "text", text }] },
        { id: "native-image", type: "agentMessage", text: answer },
      ] }],
    } });
    const parts = messages.flatMap((message) => message.parts);
    const receipt = parts.find((part) => part.type === "text" && part.text === `Which image?\n\n${answer}`);
    expect(receipt).toMatchObject({ type: "text", completed: true, phase: "commentary" });
    expect(receipt).not.toHaveProperty("inlineAssets");
    expect(parts.find((part) => part.type === "text" && part.text === answer))
      .toMatchObject({ inlineAssets: [{ sourcePath: imagePath }] });
    expect(messages.every((message) => message.role === "assistant")).toBe(true);
  });

  it("preserves raw text, visible text, citations, phase and identity without mutating the input", () => {
    const input = { ...part(), text: "Raw native content", displayText: `![Preview](${imagePath})`, citations: [{ note: "Source note" }] };
    const result = withCodexAssistantImages(input, THREAD_ID);
    expect(result).toMatchObject(input);
    expect(result.inlineAssets).toHaveLength(1);
    expect(input).not.toHaveProperty("inlineAssets");
    expect(withCodexAssistantImages(input, THREAD_ID)).toEqual(result);
  });

  it.each([["remote-host", true], ["local", false]])("does not materialize images from %s with completed=%s", (host, completed) => {
    expect(desktopMessage(`![Preview](${imagePath})`, host, completed).parts[0]).not.toHaveProperty("inlineAssets");
  });

  it.each([
    ["workspace", "preview.png"],
    ["visualizations", "2026", "10", "14", "11111111-1111-4111-8111-111111111112", "preview.png"],
    ["visualizations", "2026", "02", "30", THREAD_ID, "preview.png"],
    ["visualizations", "2026", "1", "14", THREAD_ID, "preview.png"],
    ["visualizations", "2026", "10", "14", `${THREAD_ID}-other`, "preview.png"],
  ])("rejects references outside the exact thread and date structure: %j", (...segments) => {
    const path = writeImage(...segments);
    expect(withCodexAssistantImages(part(`![Preview](${path})`), THREAD_ID)).not.toHaveProperty("inlineAssets");
  });

  it("rejects traversal spellings and invalid native identities", () => {
    const traversal = imagePath.replace("preview.png", "nested/../preview.png");
    expect(withCodexAssistantImages(part(`![Preview](${traversal})`), THREAD_ID)).not.toHaveProperty("inlineAssets");
    expect(withCodexAssistantImages(part(), "thread-1")).not.toHaveProperty("inlineAssets");
  });

  it.skipIf(process.platform === "win32")("rejects file and directory symlinks that escape the current thread", () => {
    const elsewhere = writeImage("private", "preview.png");
    rmSync(imagePath);
    symlinkSync(elsewhere, imagePath);
    expect(withCodexAssistantImages(part(), THREAD_ID)).not.toHaveProperty("inlineAssets");
    rmSync(join(imagePath, ".."), { recursive: true });
    symlinkSync(join(elsewhere, ".."), join(imagePath, ".."));
    expect(withCodexAssistantImages(part(), THREAD_ID)).not.toHaveProperty("inlineAssets");
  });

  it.each(["<svg xmlns='http://www.w3.org/2000/svg'></svg>", "GIF89a"])("rejects image data that does not match the declared PNG format: %s", (data) => {
    writeFileSync(imagePath, data);
    expect(withCodexAssistantImages(part(), THREAD_ID)).not.toHaveProperty("inlineAssets");
  });

  it("rejects oversized images and image directories", () => {
    truncateSync(imagePath, MAX_IMAGE_SIZE_BYTES + 1);
    expect(withCodexAssistantImages(part(), THREAD_ID)).not.toHaveProperty("inlineAssets");
    rmSync(imagePath);
    mkdirSync(imagePath);
    expect(withCodexAssistantImages(part(), THREAD_ID)).not.toHaveProperty("inlineAssets");
  });

  it("deduplicates references and caps a native reply at four images", () => {
    const paths = Array.from({ length: 5 }, (_, index) => writeImage("visualizations", "2026", "10", "14", THREAD_ID, `image-${index}.png`));
    const text = [paths[0], ...paths].map(path => `![Preview](${path})`).join("\n\n");
    const result = withCodexAssistantImages(part(text), THREAD_ID);
    expect(result.inlineAssets?.map(asset => asset.sourcePath)).toEqual(paths.slice(0, 4));
  });

  it.each([
    (path: string) => `\`![Preview](${path})\``,
    (path: string) => `\`\`\`markdown\n![Preview](${path})\n\`\`\``,
    (path: string) => `[Preview](${path})`,
    (path: string) => `Example: ![Preview](${path})`,
  ])("does not authorize files mentioned as code, links or inline examples", (format) => {
    expect(withCodexAssistantImages(part(format(imagePath)), THREAD_ID)).not.toHaveProperty("inlineAssets");
  });

  it("retries missing files and invalidates cached bytes when an image changes", () => {
    rmSync(imagePath);
    expect(withCodexAssistantImages(part(), THREAD_ID)).not.toHaveProperty("inlineAssets");
    writeFileSync(imagePath, PNG);
    const initial = withCodexAssistantImages(part(), THREAD_ID).inlineAssets![0].url;
    writeFileSync(imagePath, Buffer.concat([PNG, Buffer.from([0])]));
    const updated = withCodexAssistantImages(part(), THREAD_ID).inlineAssets![0].url;
    expect(updated).not.toBe(initial);
  });

  it("matches file URLs by their exact Markdown reference", () => {
    const path = writeImage("visualizations", "2026", "10", "14", THREAD_ID, "preview image.png");
    const source = pathToFileURL(path).href;
    expect(withCodexAssistantImages(part(`![Preview](${source})`), THREAD_ID).inlineAssets).toMatchObject([{ sourcePath: source }]);
  });
});
