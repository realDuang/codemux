import { MessageV2, Session, Config, Permission, Project } from "../types/opencode";
import { logger } from "./logger";

export class OpenCodeClient {
  private baseUrl: string;
  private currentDirectory: string | null = null;

  constructor(baseUrl?: string) {
    // Read configured server URL from localStorage, use default if not found
    const savedUrl = localStorage.getItem("opencode_server_url");
    this.baseUrl = baseUrl || savedUrl || "/opencode-api";
  }

  // Set server URL
  setServerUrl(url: string) {
    this.baseUrl = url;
    localStorage.setItem("opencode_server_url", url);
  }

  // Get current server URL
  getServerUrl(): string {
    return this.baseUrl;
  }

  // Set current working directory for API requests
  setDirectory(directory: string | null) {
    this.currentDirectory = directory;
    logger.debug("[OpenCodeClient] Directory set to:", directory);
  }

  // Get current working directory
  getDirectory(): string | null {
    return this.currentDirectory;
  }

  // Session management
  async listSessions(directory?: string) {
    const params = new URLSearchParams();
    if (directory) {
      params.set("directory", directory);
    }
    const queryString = params.toString();
    const endpoint = queryString ? `/session?${queryString}` : "/session";
    return this.request<Session.Info[]>(endpoint);
  }

  async listAllSessions() {
    return this.request<Session.Info[]>("/session");
  }

  /**
   * List sessions for a specific directory.
   * Uses explicit header instead of relying on currentDirectory.
   */
  async listSessionsForDirectory(directory: string): Promise<Session.Info[]> {
    const response = await fetch(`${this.baseUrl}/session`, {
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": directory,
      },
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.statusText}`);
    }

    return response.json();
  }

  // Project management
  async listProjects() {
    return this.request<Project.Info[]>("/project");
  }

  async getCurrentProject() {
    return this.request<Project.Info>("/project/current");
  }

  async updateProject(
    projectID: string,
    updates: { name?: string; icon?: Project.Info["icon"]; commands?: Project.Info["commands"] }
  ) {
    return this.request<Project.Info>(`/project/${projectID}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  }

  /**
   * Initialize a project by creating a session in the given directory.
   * OpenCode auto-creates and persists projects when a session is created in a git repo.
   * Simply calling /project/current doesn't persist the project to storage.
   */
  async initializeProject(directory: string): Promise<{ project: Project.Info; session: Session.Info | null }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-opencode-directory": directory,
    };

    const projectResponse = await fetch(`${this.baseUrl}/project/current`, { headers });
    if (!projectResponse.ok) {
      const errorText = await projectResponse.text();
      if (errorText.includes("not a git repository") || errorText.includes("fatal: not a git")) {
        throw new Error("NOT_GIT_REPO");
      }
      throw new Error(`API Error: ${projectResponse.statusText}`);
    }
    const project = await projectResponse.json() as Project.Info;

    const sessionResponse = await fetch(`${this.baseUrl}/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: `Session - ${new Date().toISOString()}` }),
    });
    
    let session: Session.Info | null = null;
    if (sessionResponse.ok) {
      session = await sessionResponse.json() as Session.Info;
    } else {
      console.warn("[initializeProject] Session creation failed, project may not be persisted");
    }

    return { project, session };
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

  async createSessionInDirectory(directory: string, title?: string) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-opencode-directory": directory,
    };

    const response = await fetch(`${this.baseUrl}/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title }),
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.statusText}`);
    }

    return response.json() as Promise<Session.Info>;
  }

  async deleteSession(id: string) {
    return this.request(`/session/${id}`, { method: "DELETE" });
  }

  async getSession(id: string) {
    return this.request<Session.Info>(`/session/${id}`);
  }

  // Message operations
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

  async updateSession(id: string, updates: { title?: string }) {
    return this.request<Session.Info>(`/session/${id}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  }

  async summarizeSession(id: string, providerID: string, modelID: string) {
    return this.request<void>(`/session/${id}/summarize`, {
      method: "POST",
      body: JSON.stringify({ providerID, modelID }),
    });
  }

  // Config management
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

  // Local storage for default model settings (OpenCode has no global config API)
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

  // SSE connection
  connectSSE(
    onEvent: (event: { type: string; data: any }) => void,
  ): () => void {
    let sseUrl = `${this.baseUrl}/global/event`;
    if (this.currentDirectory) {
      sseUrl += `?directory=${encodeURIComponent(this.currentDirectory)}`;
    }
    const eventSource = new EventSource(sseUrl);

    logger.debug("[SSE Client] Connected to:", sseUrl);

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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((options?.headers as Record<string, string>) || {}),
    };

    // Add directory header if set
    if (this.currentDirectory) {
      headers["x-opencode-directory"] = this.currentDirectory;
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers,
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
