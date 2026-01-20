import { MessageV2, Session, Config, Permission } from "../types/opencode";
import { logger } from "./logger";

export class OpenCodeClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    // 从 localStorage 读取配置的服务器 URL，如果没有则使用默认值
    const savedUrl = localStorage.getItem("opencode_server_url");
    this.baseUrl = baseUrl || savedUrl || "/opencode-api";
  }

  // 设置服务器 URL
  setServerUrl(url: string) {
    this.baseUrl = url;
    localStorage.setItem("opencode_server_url", url);
  }

  // 获取当前服务器 URL
  getServerUrl(): string {
    return this.baseUrl;
  }

  // 会话管理
  async listSessions() {
    return this.request<Session.Info[]>("/session");
  }

  async createSession(title?: string, modelID?: string, providerID?: string) {
    const body = {
      title,
      ...(modelID && { modelID }),
      ...(providerID && { providerID }),
    };

    return this.request<Session.Info>("/session", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async deleteSession(id: string) {
    return this.request(`/session/${id}`, { method: "DELETE" });
  }

  async getSession(id: string) {
    return this.request<Session.Info>(`/session/${id}`);
  }

  // 消息操作
  async sendMessage(
    sessionId: string,
    text: string,
    options?: {
      agent?: "build" | "plan";
      modelID?: string;
      providerID?: string;
    },
  ) {
    const body = {
      parts: [{ type: "text", text }],
      ...(options?.agent && { agent: options.agent }),
      ...(options?.modelID && options?.providerID && {
        model: {
          providerID: options.providerID,
          modelID: options.modelID,
        },
      }),
    };

    return this.request(`/session/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getMessages(sessionId: string) {
    return this.request<MessageV2.Info[]>(`/session/${sessionId}/message`);
  }

  async getMessageParts(sessionId: string, messageId: string) {
    return this.request<MessageV2.Part[]>(
      `/session/${sessionId}/message/${messageId}/part`,
    );
  }

  // 配置管理
  async getProviders() {
    return this.request<Config.ProviderResponse>("/provider");
  }

  async getAgents() {
    return this.request<Config.AgentInfo[]>("/agent");
  }

  // Permission operations
  async respondToPermission(requestID: string, reply: Permission.Reply) {
    return this.request<boolean>(`/permission/${requestID}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply }),
    });
  }

  async listPermissions() {
    return this.request<Permission.Request[]>("/permission");
  }

  // 本地存储默认模型设置（因为OpenCode没有全局配置API）
  getDefaultModel(): { providerID: string; modelID: string } | null {
    const stored = localStorage.getItem("opencode_default_model");
    return stored ? JSON.parse(stored) : null;
  }

  setDefaultModel(providerID: string, modelID: string) {
    localStorage.setItem(
      "opencode_default_model",
      JSON.stringify({ providerID, modelID }),
    );
  }

  // SSE 连接
  connectSSE(
    onEvent: (event: { type: string; data: any }) => void,
  ): () => void {
    const eventSource = new EventSource(`${this.baseUrl}/global/event`);

    logger.debug("[SSE Client] Connected to:", `${this.baseUrl}/global/event`);

    eventSource.onopen = () => {
      logger.debug("[SSE Client] Connection opened");
    };

    eventSource.onerror = (error) => {
      logger.error("[SSE Client] Error:", error);
    };

    eventSource.onmessage = (event) => {
      logger.debug("[SSE Client] Raw message event:", event.data);

      try {
        const parsed = JSON.parse(event.data);
        logger.debug("[SSE Client] Parsed data:", parsed);

        if (!parsed.payload) return;

        const eventType = parsed.payload.type;
        const properties = parsed.payload.properties;

        logger.debug("[SSE Client] Event type:", eventType);
        logger.debug("[SSE Client] Properties:", properties);

        // Event type to data property mapping
        const eventDataMap: Record<string, string | null> = {
          "message.part.updated": "part",
          "session.updated": "info",
          "session.created": "info",
          "message.updated": "info",
          "permission.asked": null, // Use properties directly
          "permission.replied": null,
        };

        if (eventType in eventDataMap) {
          const dataKey = eventDataMap[eventType];
          const data = dataKey ? properties[dataKey] : properties;
          if (data) {
            onEvent({ type: eventType, data });
          }
        } else {
          logger.debug("[SSE Client] Unhandled event type:", eventType);
        }
      } catch (e) {
        logger.error(
          "[SSE Client] Failed to parse SSE message",
          e,
          event.data,
        );
      }
    };

    return () => {
      logger.debug("[SSE Client] Closing connection");
      eventSource.close();
    };
  }

  private async request<T>(
    endpoint: string,
    options?: RequestInit,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.statusText}`);
    }

    // Some endpoints might return empty body
    if (response.status === 204) {
      return {} as T;
    }

    return response.json();
  }
}

export const client = new OpenCodeClient();
