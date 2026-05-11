// ============================================================================
// Teams Message Transport
// Implements MessageTransport for Microsoft Teams via Bot Framework REST API.
// Uses direct fetch() calls — no botbuilder SDK dependency.
//
// API Reference: https://learn.microsoft.com/en-us/azure/bot-service/rest-api/
//   - Send:   POST {serviceUrl}/v3/conversations/{conversationId}/activities
//   - Update: PUT  {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}
//   - Delete: DELETE {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}
//   - Auth:   POST https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token
//
// Compound message ID format: "conversationId|activityId"
// (both are needed to construct update/delete URLs)
// ============================================================================

import type { MessageTransport } from "../streaming/message-transport";
import type { TokenBucket } from "../streaming/rate-limiter";
import { TokenManager } from "../streaming/token-manager";
import { channelLog } from "../../services/logger";

const LOG_PREFIX = "[Teams]";

export class TeamsTransport implements MessageTransport {
  private tokenManager: TokenManager;

  /** Maps conversationId → serviceUrl (set when activities are received) */
  private serviceUrls = new Map<string, string>();

  constructor(
    private appId: string,
    appPassword: string,
    private rateLimiter: TokenBucket,
    private tenantId?: string,
  ) {
    // SingleTenant bots use tenant-specific endpoint; MultiTenant uses botframework.com
    const authority = tenantId || "botframework.com";
    channelLog.info(`${LOG_PREFIX} Token authority: ${authority}`);
    this.tokenManager = new TokenManager(async () => {
      const params = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: appId,
        client_secret: appPassword,
        scope: "https://api.botframework.com/.default",
      });
      const res = await fetch(
        `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`,
        { method: "POST", body: params },
      );
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Token fetch failed: ${res.status} ${body}`);
      }
      const data = (await res.json()) as {
        access_token: string;
        expires_in: number;
      };
      return { token: data.access_token, expiresInSeconds: data.expires_in };
    });
  }

  /** Register the serviceUrl for a conversation (called on every incoming activity) */
  setServiceUrl(conversationId: string, serviceUrl: string): void {
    // Normalize: ensure trailing slash
    const normalized = serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`;
    this.serviceUrls.set(conversationId, normalized);
  }

  // =========================================================================
  // MessageTransport Interface
  // =========================================================================

  /**
   * Send a text message to a Teams conversation.
   * Returns compound message ID ("conversationId|activityId"), or empty string on failure.
   */
  async sendText(chatId: string, text: string): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const result = await this.callBotApi(chatId, "POST", undefined, {
        type: "message",
        text,
        textFormat: "markdown",
      });
      if (result?.id) {
        return this.composeMessageId(chatId, result.id);
      }
      return "";
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to send text message:`, err);
      return "";
    }
  }

  /** Send a markdown-formatted message. Teams sendText already uses textFormat: "markdown". */
  async sendMarkdown(chatId: string, markdown: string): Promise<string> {
    return this.sendText(chatId, markdown);
  }

  /**
   * Update an existing message with new text content.
   * The messageId format is "conversationId|activityId".
   */
  async updateText(messageId: string, text: string): Promise<void> {
    const { conversationId, activityId } = this.parseMessageId(messageId);
    if (!conversationId || !activityId) return;

    try {
      await this.callBotApi(conversationId, "PUT", activityId, {
        type: "message",
        text,
        textFormat: "markdown",
      });
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to update message ${messageId}:`, err);
    }
  }

  /**
   * Delete a message by its compound messageId ("conversationId|activityId").
   */
  async deleteMessage(messageId: string): Promise<void> {
    const { conversationId, activityId } = this.parseMessageId(messageId);
    if (!conversationId || !activityId) return;

    await this.rateLimiter.consume();
    await this.callBotApi(conversationId, "DELETE", activityId);
  }

  /**
   * Send rich content (Adaptive Card) to a Teams conversation.
   * Content is a JSON string representing an Adaptive Card.
   * Returns compound message ID, or empty string on failure.
   */
  async sendRichContent(chatId: string, content: string): Promise<string> {
    try {
      await this.rateLimiter.consume();
      let cardContent: unknown;
      try {
        cardContent = JSON.parse(content);
      } catch {
        // Fallback: treat as plain text
        return this.sendText(chatId, content);
      }

      const result = await this.callBotApi(chatId, "POST", undefined, {
        type: "message",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: cardContent,
          },
        ],
      });
      if (result?.id) {
        return this.composeMessageId(chatId, result.id);
      }
      return "";
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to send rich content:`, err);
      return "";
    }
  }

  // =========================================================================
  // Teams-Specific Methods (not part of MessageTransport interface)
  // =========================================================================

  /**
   * Send an Adaptive Card with Action.Submit buttons.
   * Returns compound message ID, or empty string on failure.
   */
  async sendAdaptiveCard(
    chatId: string,
    card: Record<string, unknown>,
  ): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const result = await this.callBotApi(chatId, "POST", undefined, {
        type: "message",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: card,
          },
        ],
      });
      if (result?.id) {
        return this.composeMessageId(chatId, result.id);
      }
      return "";
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to send Adaptive Card:`, err);
      return "";
    }
  }

  /**
   * Update an existing message with an Adaptive Card.
   * Used for finalizing streaming with a rich card.
   */
  async updateWithAdaptiveCard(
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    const { conversationId, activityId } = this.parseMessageId(messageId);
    if (!conversationId || !activityId) return;

    try {
      await this.callBotApi(conversationId, "PUT", activityId, {
        type: "message",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: card,
          },
        ],
      });
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to update with Adaptive Card:`, err);
    }
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  /**
   * Compose a compound message ID: "conversationId|activityId".
   * Both pieces are needed for update/delete API calls.
   */
  composeMessageId(conversationId: string, activityId: string): string {
    return `${conversationId}|${activityId}`;
  }

  /**
   * Parse a compound message ID back into conversationId and activityId.
   */
  private parseMessageId(compoundId: string): {
    conversationId: string;
    activityId: string;
  } {
    const pipeIdx = compoundId.indexOf("|");
    if (pipeIdx === -1) {
      return { conversationId: "", activityId: compoundId };
    }
    return {
      conversationId: compoundId.slice(0, pipeIdx),
      activityId: compoundId.slice(pipeIdx + 1),
    };
  }

  /**
   * Get authorization headers with a valid Bearer token.
   */
  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.tokenManager.getToken();
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Build the Bot Framework API URL for a conversation.
   */
  private buildApiUrl(
    conversationId: string,
    activityId?: string,
  ): string | null {
    const serviceUrl = this.serviceUrls.get(conversationId);
    if (!serviceUrl) {
      channelLog.error(
        `${LOG_PREFIX} No serviceUrl for conversation: ${conversationId}`,
      );
      return null;
    }
    const base = `${serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities`;
    return activityId ? `${base}/${encodeURIComponent(activityId)}` : base;
  }

  /**
   * Call a Bot Framework REST API endpoint.
   * @param conversationId - The conversation to operate on
   * @param method - HTTP method (POST, PUT, DELETE)
   * @param activityId - Optional activity ID (for update/delete)
   * @param body - Optional request body
   * @returns Parsed JSON response, or null on failure
   */
  private async callBotApi(
    conversationId: string,
    method: "POST" | "PUT" | "DELETE",
    activityId?: string,
    body?: Record<string, unknown>,
  ): Promise<any> {
    const url = this.buildApiUrl(conversationId, activityId);
    if (!url) return null;

    const headers = await this.getAuthHeaders();
    const options: RequestInit = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);

    if (!res.ok) {
      const errBody = await res.text();
      channelLog.error(
        `${LOG_PREFIX} API ${method} ${activityId || "new"} failed: ${res.status} ${errBody}`,
      );
      return null;
    }

    // DELETE returns 200 with no body
    if (method === "DELETE") return null;

    return res.json();
  }
}
