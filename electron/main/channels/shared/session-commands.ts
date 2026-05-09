// ============================================================================
// Shared Session Command Handlers — Class-B operations on the current session.
//
// These commands operate on the channel's "current session context". Each
// channel passes a small SessionContext object that encapsulates: how to send
// text, the active conversationId, the active engineType. Behavior is
// identical across all channels — there is no per-channel customization.
// ============================================================================

import type { GatewayWsClient } from "../gateway-ws-client";
import {
  isReasoningEffort,
  type EngineType,
  type ReasoningEffort,
  type UnifiedModelInfo,
} from "../../../../src/types/unified";
import type { ParsedCommand } from "./command-types";
import { buildHistoryEntries } from "./list-builders";

function escapeMarkdownInline(value: string): string {
  return value.replace(/[\\*`]/g, "\\$&");
}

const effortLabels: Record<ReasoningEffort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  max: "最大",
};

function getModelEfforts(models: UnifiedModelInfo[], modelId: string | undefined): ReasoningEffort[] {
  if (!modelId) return [];
  return models.find((model) => model.modelId === modelId)?.capabilities?.supportedReasoningEfforts ?? [];
}

function getModelDefaultEffort(models: UnifiedModelInfo[], modelId: string | undefined): ReasoningEffort | undefined {
  if (!modelId) return undefined;
  return models.find((model) => model.modelId === modelId)?.capabilities?.defaultReasoningEffort;
}

function resolveEffortForModelChange(
  models: UnifiedModelInfo[],
  modelId: string,
  currentEffort: ReasoningEffort | undefined,
): ReasoningEffort | null | undefined {
  const model = models.find((item) => item.modelId === modelId);
  if (!model) return undefined;
  const supportedEfforts = model.capabilities?.supportedReasoningEfforts ?? [];
  if (supportedEfforts.length === 0) return null;
  if (currentEffort && supportedEfforts.includes(currentEffort)) return currentEffort;
  return model.capabilities?.defaultReasoningEffort ?? null;
}

/**
 * The minimal context a session-ops command needs. Channels build this from
 * their own state (P2P temp session, group binding, etc.) and pass it in.
 */
export interface SessionContext {
  /** The conversation/session id used by the gateway. */
  conversationId: string;
  /** Engine driving this session. */
  engineType: EngineType;
  /** Display title of the session (used in /status). */
  title?: string;
  /** Project directory (used in /status). */
  directory?: string;
}

/**
 * Run a Class-B session-ops command. Returns true if the command was handled
 * (caller should NOT fall through to other dispatch). Returns false if the
 * command is not a session-op (caller should keep dispatching).
 *
 * If the channel has no current session and a session-op is invoked, this
 * function emits a "no active session" reply and returns true (handled).
 */
export async function handleSessionOpsCommand(
  command: ParsedCommand,
  args: {
    sendText: (text: string) => Promise<unknown>;
    gatewayClient: GatewayWsClient;
    /** Returns the active session context, or null if none. */
    getContext: () => SessionContext | null;
  },
): Promise<boolean> {
  const { command: name, subcommand } = command;

  switch (name) {
    case "cancel":
    case "status":
    case "mode":
    case "model":
    case "effort":
    case "history":
      break;
    default:
      return false;
  }

  const ctx = args.getContext();
  if (!ctx) {
    await args.sendText("📋 当前没有活动会话。使用 `/project` 选择项目，或 `/new` 创建会话。");
    return true;
  }

  switch (name) {
    case "cancel":
      await args.gatewayClient.cancelMessage(ctx.conversationId);
      await args.sendText("📋 消息已取消。");
      return true;

    case "status": {
      const projectName = ctx.directory?.split(/[\\/]/).pop();
      const lines = ["**📋 会话状态**", ""];
      if (projectName) lines.push(`项目：${projectName}（${ctx.engineType}）`);
      else lines.push(`引擎：${ctx.engineType}`);
      if (ctx.title) lines.push(`标题：${ctx.title}`);
      lines.push(`会话：\`${ctx.conversationId}\``);
      await args.sendText(lines.join("\n"));
      return true;
    }

    case "mode": {
      const modes = await args.gatewayClient.listModes(ctx.engineType);
      if (modes.length === 0) {
        await args.sendText("📋 当前引擎不支持模式切换。");
        return true;
      }

      const isList =
        subcommand === "list" ||
        (!subcommand && (!command.args || command.args.length === 0));
      if (isList) {
        const session = await args.gatewayClient.getSession(ctx.conversationId);
        const currentModeId = session.mode ?? modes[0]?.id;
        const lines = ["**📋 模式列表**", ""];
        for (const mode of modes) {
          const current = mode.id === currentModeId ? "（当前会话）" : "";
          const modeId = escapeMarkdownInline(mode.id);
          const label = escapeMarkdownInline(mode.label || mode.id);
          if (mode.description) {
            lines.push(`- ${label} · \`${modeId}\`${current} — ${escapeMarkdownInline(mode.description)}`);
          } else {
            lines.push(`- ${label} · \`${modeId}\`${current}`);
          }
        }
        lines.push("");
        lines.push("使用 `/mode mode-id` 切换当前会话模式。");
        await args.sendText(lines.join("\n"));
        return true;
      }

      const modeId = command.args?.[0];
      if (!modeId || !modes.some((mode) => mode.id === modeId)) {
        await args.sendText(`📋 当前引擎支持的模式：${modes.map((mode) => `\`${escapeMarkdownInline(mode.id)}\``).join("、")}`);
        return true;
      }

      await args.gatewayClient.setMode({
        sessionId: ctx.conversationId,
        modeId,
      });
      await args.sendText(`📋 当前会话模式已切换为：${modeId}`);
      return true;
    }

    case "model": {
      const isList =
        subcommand === "list" ||
        (!subcommand && (!command.args || command.args.length === 0));
      if (isList) {
        const [result, session] = await Promise.all([
          args.gatewayClient.listModels(ctx.engineType),
          args.gatewayClient.getSession(ctx.conversationId),
        ]);
        const currentModelId = session.modelId ?? result.currentModelId;
        let currentMarked = false;
        const lines = ["**📋 模型列表**", ""];
        for (const m of result.models) {
          const current = m.modelId === currentModelId ? "（当前会话）" : "";
          if (current) currentMarked = true;
          const modelId = escapeMarkdownInline(m.modelId);
          if (m.name && m.name !== m.modelId) {
            lines.push(`- ${escapeMarkdownInline(m.name)} · \`${modelId}\`${current}`);
          } else {
            lines.push(`- \`${modelId}\`${current}`);
          }
        }
        if (currentModelId && !currentMarked) {
          lines.push(`- \`${escapeMarkdownInline(currentModelId)}\`（当前会话）`);
        }
        lines.push("");
        lines.push("使用 `/model model-id` 切换当前会话模型。");
        await args.sendText(lines.join("\n"));
      } else if (command.args && command.args.length > 0) {
        const modelId = command.args[0];
        const [result, session] = await Promise.all([
          args.gatewayClient.listModels(ctx.engineType),
          args.gatewayClient.getSession(ctx.conversationId),
        ]);
        const nextEffort = resolveEffortForModelChange(result.models, modelId, session.reasoningEffort);
        const config = nextEffort === undefined
          ? { modelId }
          : { modelId, reasoningEffort: nextEffort };
        await args.gatewayClient.updateSessionConfig(ctx.conversationId, config);
        await args.sendText(`📋 当前会话模型已切换为：${modelId}`);
      }
      return true;
    }

    case "effort": {
      const [result, session] = await Promise.all([
        args.gatewayClient.listModels(ctx.engineType),
        args.gatewayClient.getSession(ctx.conversationId),
      ]);
      const currentModelId = session.modelId ?? result.currentModelId;
      const supportedEfforts = getModelEfforts(result.models, currentModelId);
      if (supportedEfforts.length === 0) {
        await args.sendText("📋 当前模型不支持推理级别设置。");
        return true;
      }

      const currentEffort = session.reasoningEffort && supportedEfforts.includes(session.reasoningEffort)
        ? session.reasoningEffort
        : getModelDefaultEffort(result.models, currentModelId);
      const isList =
        subcommand === "list" ||
        (!subcommand && (!command.args || command.args.length === 0));

      if (isList) {
        const lines = ["**📋 推理级别**", ""];
        if (currentModelId) lines.push(`当前模型：\`${escapeMarkdownInline(currentModelId)}\``);
        for (const effort of supportedEfforts) {
          const current = effort === currentEffort ? "（当前会话）" : "";
          lines.push(`- \`${effort}\` · ${effortLabels[effort]}${current}`);
        }
        lines.push("");
        lines.push("使用 `/effort low|medium|high|max` 切换当前会话推理级别。");
        await args.sendText(lines.join("\n"));
        return true;
      }

      const nextEffort = command.args?.[0];
      if (!isReasoningEffort(nextEffort) || !supportedEfforts.includes(nextEffort)) {
        await args.sendText(`📋 当前模型支持的推理级别：${supportedEfforts.map((effort) => `\`${effort}\``).join("、")}`);
        return true;
      }

      await args.gatewayClient.updateSessionConfig(ctx.conversationId, { reasoningEffort: nextEffort });
      await args.sendText(`📋 当前会话推理级别已切换为：${effortLabels[nextEffort]}（${nextEffort}）`);
      return true;
    }

    case "history": {
      const messages = await args.gatewayClient.listMessages(ctx.conversationId);
      const entries = buildHistoryEntries(messages);
      if (entries.length === 0) {
        await args.sendText("📋 暂无会话历史记录。");
      } else {
        await args.sendText("**📋 会话历史**");
        for (const entry of entries) {
          await args.sendText(`${entry.emoji} ${entry.text}`);
        }
      }
      return true;
    }
  }

  return false;
}
