// ============================================================================
// OpenCode Type Converters
//
// Pure (or near-pure) functions that convert between SDK types and unified types.
// Only dependency is the `engineType` string, passed as a parameter.
// ============================================================================

import type {
  Session as SdkSession,
  Part as SdkPart,
  ToolState as SdkToolState,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2";
import { normalizeToolName, inferToolKind } from "../../../../src/types/tool-mapping";
import type {
  EngineType,
  UnifiedSession,
  UnifiedMessage,
  UnifiedPart,
  UnifiedModelInfo,
  ToolPart,
  ToolState,
} from "../../../../src/types/unified";

export function convertSession(engineType: EngineType, sdk: SdkSession): UnifiedSession {
  return {
    id: sdk.id,
    engineType,
    directory: sdk.directory.replaceAll("\\", "/"),
    title: sdk.title,
    parentId: sdk.parentID,
    projectId: sdk.projectID,
    time: {
      created: sdk.time.created,
      updated: sdk.time.updated,
    },
    engineMeta: {
      slug: sdk.slug,
      projectID: sdk.projectID,
      version: sdk.version,
      compacting: sdk.time.compacting,
      summary: sdk.summary,
      share: sdk.share,
    },
  };
}

/** Per-million-token pricing rates */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Calculate USD cost from token counts and per-million-token pricing */
function computeCost(
  tokens: { input: number; output: number; cache?: { read: number; write: number } },
  pricing: ModelPricing,
): number {
  return (
    (tokens.input * pricing.input +
      tokens.output * pricing.output +
      (tokens.cache?.read ?? 0) * pricing.cacheRead +
      (tokens.cache?.write ?? 0) * pricing.cacheWrite) / 1_000_000
  );
}

export function convertMessage(engineType: EngineType, sdk: any, pricing?: ModelPricing): UnifiedMessage {
  // SDK Message is a union of UserMessage | AssistantMessage
  // Both have id, sessionID, role, time
  const errorStr = sdk.error
    ? (typeof sdk.error === "string" ? sdk.error : sdk.error.message ?? sdk.error.name ?? "Error")
    : undefined;

  // Normalize OpenCode's abort error to the unified "Cancelled" convention
  // so the frontend uses a single check (error === "Cancelled") across all engines.
  const normalizedError = errorStr && (
    errorStr === "MessageAbortedError" || (sdk.error?.name === "MessageAbortedError")
  ) ? "Cancelled" : errorStr;

  return {
    id: sdk.id,
    sessionId: sdk.sessionID,
    role: sdk.role,
    time: {
      created: sdk.time?.created ?? Date.now(),
      completed: sdk.time?.completed,
    },
    parts: (sdk.parts ?? []).filter(Boolean).map((p: SdkPart) => convertPart(engineType, p)),
    tokens: sdk.tokens,
    cost: sdk.cost || (sdk.tokens && pricing ? computeCost(sdk.tokens, pricing) : undefined),
    modelId: sdk.modelID,
    providerId: sdk.providerID,
    mode: sdk.mode,
    error: normalizedError,
    workingDirectory: (sdk as any).path?.cwd,
    isCompaction: (sdk as any).summary === true,
    engineMeta: {
      path: sdk.path,
      agent: sdk.agent,
      system: sdk.system,
      summary: sdk.summary,
    },
  };
}

export function convertPart(_engineType: EngineType, sdk: SdkPart): UnifiedPart {
  const base = {
    id: (sdk as any).id ?? "",
    messageId: (sdk as any).messageID ?? "",
    sessionId: (sdk as any).sessionID ?? "",
  };

  switch (sdk.type) {
    case "text":
      return { ...base, type: "text", text: sdk.text, synthetic: sdk.synthetic };
    case "reasoning":
      return { ...base, type: "reasoning", text: sdk.text };
    case "file":
      return { ...base, type: "file", mime: sdk.mime, filename: sdk.filename ?? "", url: sdk.url };
    case "step-start":
      return { ...base, type: "step-start" };
    case "step-finish":
      return { ...base, type: "step-finish" };
    case "snapshot":
      // SDK SnapshotPart has `snapshot: string` (single hash), unified has `files: string[]`
      return { ...base, type: "snapshot", files: sdk.snapshot ? [sdk.snapshot] : [] };
    case "patch":
      // SDK PatchPart has `hash: string, files: string[]`, unified has `content: string, path: string`
      return { ...base, type: "patch", content: sdk.hash ?? "", path: (sdk.files?.[0] ?? "") };
    case "tool": {
      const normalizedTool = normalizeToolName("opencode", sdk.tool);
      const kind = inferToolKind(undefined, normalizedTool);
      const state = sdk.state as SdkToolState;
      const part: ToolPart = {
        ...base,
        type: "tool",
        callId: sdk.callID,
        normalizedTool,
        originalTool: sdk.tool,
        title: (state as any)?.title ?? sdk.tool,
        kind,
        state: convertToolState(state),
      };
      return part;
    }
    default:
      // Handle new part types (agent, retry, compaction, subtask) gracefully
      // by falling back to a text representation
      return { ...base, type: "text", text: `[${(sdk as any).type}]` };
  }
}

function convertToolState(sdkState: SdkToolState): ToolState {
  switch (sdkState.status) {
    case "pending":
      return { status: "pending", input: sdkState.input };
    case "running":
      return {
        status: "running",
        input: sdkState.input,
        time: { start: sdkState.time.start },
      };
    case "completed":
      return {
        status: "completed",
        input: sdkState.input,
        output: sdkState.output,
        title: sdkState.title,
        time: {
          start: sdkState.time.start,
          end: sdkState.time.end,
          duration: sdkState.time.end - sdkState.time.start,
        },
        metadata: sdkState.metadata,
      };
    case "error":
      return {
        status: "error",
        input: sdkState.input,
        error: sdkState.error,
        time: {
          start: sdkState.time.start,
          end: sdkState.time.end,
          duration: sdkState.time.end - sdkState.time.start,
        },
      };
  }
}

export function convertProviders(engineType: EngineType, response: ProviderListResponse): UnifiedModelInfo[] {
  const models: UnifiedModelInfo[] = [];
  for (const provider of response.all) {
    // Only include connected providers
    if (!response.connected.includes(provider.id)) continue;

    for (const model of Object.values(provider.models)) {
      models.push({
        modelId: `${provider.id}/${model.id}`,
        name: model.name,
        description: `${model.family ?? ""} (${provider.name})`.trim(),
        engineType,
        providerId: provider.id,
        providerName: provider.name,
        cost: model.cost ? {
          input: model.cost.input,
          output: model.cost.output,
          cache: {
            read: model.cost.cache_read ?? 0,
            write: model.cost.cache_write ?? 0,
          },
        } : undefined,
        capabilities: {
          temperature: model.temperature,
          reasoning: model.reasoning,
          attachment: model.attachment,
          toolcall: model.tool_call,
        },
        meta: {
          status: model.status,
          releaseDate: model.release_date,
          limits: model.limit,
        },
      });
    }
  }
  return models;
}
