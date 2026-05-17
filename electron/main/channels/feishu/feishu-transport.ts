// ============================================================================
// Feishu Message Transport
// Implements MessageTransport for Feishu (Lark) using the Lark SDK.
// Handles rate limiting and all Feishu message API calls.
// ============================================================================

import type * as lark from "@larksuiteoapi/node-sdk";
import type { MessageTransport } from "../streaming/message-transport";
import type { TokenBucket } from "../streaming/rate-limiter";
import { feishuLog, type ScopedLogger } from "../../services/logger";

export class FeishuTransport implements MessageTransport {
  constructor(
    private larkClient: lark.Client,
    private rateLimiter: TokenBucket,
    private log: ScopedLogger = feishuLog,
  ) {}

  async sendText(chatId: string, text: string): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const res = await this.larkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
      });
      return (res as any)?.data?.message_id ?? "";
    } catch (err) {
      this.log.error("Failed to send text message:", err);
      return "";
    }
  }

  /** Send markdown wrapped in a Feishu Interactive Card with mobile-friendly configuration. */
  async sendMarkdown(chatId: string, markdown: string): Promise<string> {
    const card = JSON.stringify({
      config: { wide_screen_mode: true },
      elements: [{ tag: "markdown", content: markdown }],
    });
    return this.sendRichContent(chatId, card);
  }

  async updateText(messageId: string, text: string): Promise<void> {
    if (!messageId) return;

    try {
      await this.rateLimiter.consume();
      await this.larkClient.im.message.update({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      this.log.error(`Failed to update message ${messageId}:`, err);
    }
  }

  async deleteMessage(messageId: string): Promise<void> {
    if (!messageId) return;

    await this.rateLimiter.consume();
    await this.larkClient.im.message.delete({
      path: { message_id: messageId },
    });
  }

  async sendRichContent(chatId: string, cardJson: string): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const res = await this.larkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: cardJson,
          msg_type: "interactive",
        },
      });
      return (res as any)?.data?.message_id ?? "";
    } catch (err) {
      this.log.error("Failed to send card message:", err);
      return "";
    }
  }

  /**
   * Send a message using either chat_id or open_id as receive_id.
   * This is Feishu-specific (not part of MessageTransport interface).
   */
  async sendMessageTo(
    receiveId: string,
    receiveIdType: string,
    msgType: string,
    content: string,
  ): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const res = await this.larkClient.im.message.create({
        params: { receive_id_type: receiveIdType as any },
        data: {
          receive_id: receiveId,
          content,
          msg_type: msgType as any,
        },
      });
      return (res as any)?.data?.message_id ?? "";
    } catch (err) {
      this.log.error(`Failed to send message (${receiveIdType}=${receiveId}):`, err);
      return "";
    }
  }

  /**
   * Download an image resource from a Feishu message and return the raw bytes.
   * Aborts and returns null if the response stream exceeds `maxBytes` to guard
   * against very large attachments. Returns null on any download error.
   *
   * The Lark SDK's `im.messageResource.get` returns a wrapper exposing
   * `getReadableStream()` over the underlying HTTP stream.
   */
  async downloadMessageImage(
    messageId: string,
    fileKey: string,
    maxBytes: number,
  ): Promise<Buffer | null> {
    try {
      await this.rateLimiter.consume();
      const res = await this.larkClient.im.messageResource.get({
        params: { type: "image" },
        path: { message_id: messageId, file_key: fileKey },
      });
      const stream = (res as any).getReadableStream();
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const raw of stream) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        total += chunk.length;
        if (total > maxBytes) {
          // Best-effort: drain remaining stream so the underlying socket can recycle.
          try { stream.destroy?.(); } catch { /* ignore */ }
          this.log.warn(
            `Image ${fileKey} for message ${messageId} exceeds ${maxBytes} bytes — skipped`,
          );
          return null;
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, total);
    } catch (err) {
      this.log.error(`Failed to download image ${fileKey} for message ${messageId}:`, err);
      return null;
    }
  }
}
