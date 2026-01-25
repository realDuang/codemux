// Types needed for API client and message rendering

export namespace Project {
  export interface Info {
    id: string;
    worktree: string;
    vcs?: "git";
    name?: string;
    icon?: {
      url?: string;
      override?: string;
      color?: string;
    };
    commands?: {
      start?: string;
    };
    time: {
      created: number;
      updated: number;
      initialized?: number;
    };
    sandboxes: string[];
  }
}

export namespace MessageV2 {
  export type Role = "user" | "assistant";

  export interface Info {
    id: string;
    sessionID: string;
    role: Role;
    time: {
      created: number;
      completed?: number;
    };
    cost?: number;
    path?: {
      root: string;
      cwd: string;
    };
    summary?: boolean;
    tokens?: {
      input: number;
      output: number;
      cache: {
        read: number;
        write: number;
      };
      reasoning: number;
    };
    modelID?: string;
    providerID?: string;
    mode?: "build" | "plan" | "compaction";
    agent?: string;
    system?: string;
    error?: string;
    parts: Part[];
  }

  export type Part =
    | {
        id: string;
        messageID: string;
        sessionID: string;
        type: "text";
        text: string;
        synthetic?: boolean;
      }
    | {
        id: string;
        messageID: string;
        sessionID: string;
        type: "reasoning";
        text: string;
      }
    | {
        id: string;
        messageID: string;
        sessionID: string;
        type: "file";
        mime: string;
        filename: string;
        url: string;
      }
    | {
        id: string;
        messageID: string;
        sessionID: string;
        type: "step-start";
      }
    | {
        id: string;
        messageID: string;
        sessionID: string;
        type: "step-finish";
      }
    | {
        id: string;
        messageID: string;
        sessionID: string;
        type: "snapshot";
        files: string[];
      }
    | {
        id: string;
        messageID: string;
        sessionID: string;
        type: "patch";
        content: string;
        path: string;
      }
    | {
        id: string;
        messageID: string;
        sessionID: string;
        type: "tool";
        callID: string;
        tool: string;
        state:
          | {
              status: "pending";
            }
          | {
              status: "running";
              input: any;
              time: {
                start: number;
              };
            }
          | {
              status: "completed";
              input: any;
              output: any;
              title?: string;
              time: {
                start: number;
                end: number;
                duration: number;
              };
              metadata?: any;
            }
          | {
              status: "error";
              input: any;
              output?: any;
              error: string;
              time: {
                start: number;
                end: number;
                duration: number;
              };
            };
      };
}

export namespace Session {
  export interface Info {
    id: string;
    slug?: string;
    projectID?: string;
    directory: string;           // 项目目录路径（用于分组）
    parentID?: string;           // 父会话 ID
    title?: string;
    version?: string;
    time: {
      created: number;
      updated: number;
      compacting?: number;
      archived?: number;
    };
    summary?: {
      additions: number;
      deletions: number;
      files: number;
    };
    share?: {
      url: string;
    };
  }
}

// Permission types for authorization requests
export namespace Permission {
  export interface Request {
    id: string;
    sessionID: string;
    permission: string;
    patterns: string[];
    metadata: Record<string, unknown>;
    always: string[];
    tool?: {
      messageID: string;
      callID: string;
    };
  }

  export type Reply = "once" | "always" | "reject";
}

export namespace Config {
  export interface Model {
    id: string;
    providerID: string;
    name: string;
    family: string;
    status: string;
    cost: {
      input: number;
      output: number;
      cache: { read: number; write: number };
    };
    limit: {
      context: number;
      output: number;
    };
    capabilities: {
      temperature: boolean;
      reasoning: boolean;
      attachment: boolean;
      toolcall: boolean;
    };
    release_date: string;
  }

  export interface Provider {
    id: string;
    source: string;
    name: string;
    env: string[];
    options: Record<string, any>;
    models: Record<string, Model>;
  }

  export interface ProviderResponse {
    all: Provider[];
    connected: string[];  // IDs of providers that have authentication
    default: Record<string, string>;  // Default model ID for each provider
    recent?: string[];
    favorite?: string[];
  }

  export interface AgentInfo {
    name: string;
    options: Record<string, any>;
    permission: any[];
    mode?: string;
    native?: boolean;
  }
}
