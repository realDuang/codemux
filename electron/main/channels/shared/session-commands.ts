// ============================================================================
// Shared Session Command Handlers — Class-B operations on the current session.
//
// These commands operate on the channel's "current session context". Each
// channel passes a small SessionContext object that encapsulates: how to send
// text, the active conversationId, the active engineType. Behavior is
// identical across all channels — there is no per-channel customization.
// ============================================================================

import type { GatewayWsClient } from "../gateway-ws-client";
import type { EngineType } from "../../../../src/types/unified";
import type { ParsedCommand } from "./command-types";
import { buildHistoryEntries } from "./list-builders";

function escapeMarkdownInline(value: string): string {
  return value.replace(/[\\*`]/g, "\\$&");
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
      if (!command.args || command.args.length === 0) {
        await args.sendText([
          "**📋 模式列表**",
          "",
          "- `agent` · 默认 Agent 模式",
          "- `plan` · 规划模式",
          "- `build` · 构建模式",
          "",
          "使用 `/mode agent`、`/mode plan` 或 `/mode build` 切换模式。",
        ].join("\n"));
        return true;
      }
      await args.gatewayClient.setMode({
        sessionId: ctx.conversationId,
        modeId: command.args[0],
      });
      await args.sendText(`📋 模式已切换为：${command.args[0]}`);
      return true;
    }

    case "model": {
      const isList =
        subcommand === "list" ||
        (!subcommand && (!command.args || command.args.length === 0));
      if (isList) {
        const result = await args.gatewayClient.listModels(ctx.engineType);
        const lines = ["**📋 模型列表**", ""];
        for (const m of result.models) {
          const current = m.modelId === result.currentModelId ? "（当前）" : "";
          const modelId = escapeMarkdownInline(m.modelId);
          if (m.name && m.name !== m.modelId) {
            lines.push(`- ${escapeMarkdownInline(m.name)} · \`${modelId}\`${current}`);
          } else {
            lines.push(`- \`${modelId}\`${current}`);
          }
        }
        lines.push("");
        lines.push("使用 `/model model-id` 切换模型。");
        await args.sendText(lines.join("\n"));
      } else if (command.args && command.args.length > 0) {
        await args.gatewayClient.setModel({
          sessionId: ctx.conversationId,
          modelId: command.args[0],
        });
        await args.sendText(`📋 模型已切换为：${command.args[0]}`);
      }
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
