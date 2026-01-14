import { MessageV2, Session, Config } from "../types/opencode";

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
    const body: any = { title };
    if (modelID) body.modelID = modelID;
    if (providerID) body.providerID = providerID;

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
    mode?: "build" | "plan",
  ) {
    const body: any = {
      parts: [
        {
          type: "text",
          text: text,
        },
      ],
    };
    if (mode) {
      body.mode = mode;
    }

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

    console.log("[SSE Client] Connected to:", `${this.baseUrl}/global/event`);

    eventSource.onopen = () => {
      console.log("[SSE Client] Connection opened");
    };

    eventSource.onerror = (error) => {
      console.error("[SSE Client] Error:", error);
    };

    eventSource.onmessage = (event) => {
      console.log("[SSE Client] Raw message event:", event.data);

      try {
        const parsed = JSON.parse(event.data);
        console.log("[SSE Client] Parsed data:", parsed);

        // OpenCode 的 SSE 格式：{ payload: { type: "...", properties: {...} } }
        if (parsed.payload) {
          const eventType = parsed.payload.type;
          const properties = parsed.payload.properties;

          console.log("[SSE Client] Event type:", eventType);
          console.log("[SSE Client] Properties:", properties);

          // 根据不同的事件类型提取数据
          if (eventType === "message.part.updated" && properties.part) {
            onEvent({ type: "message.part.updated", data: properties.part });
          } else if (eventType === "session.updated" && properties.info) {
            onEvent({ type: "session.updated", data: properties.info });
          } else if (eventType === "session.created" && properties.info) {
            onEvent({ type: "session.created", data: properties.info });
          } else if (eventType === "message.updated" && properties.info) {
            onEvent({ type: "message.updated", data: properties.info });
          } else {
            console.log("[SSE Client] Unhandled event type:", eventType);
          }
        }
      } catch (e) {
        console.error(
          "[SSE Client] Failed to parse SSE message",
          e,
          event.data,
        );
      }
    };

    return () => {
      console.log("[SSE Client] Closing connection");
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
