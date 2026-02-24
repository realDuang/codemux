// ============================================================================
// Claude Code Adapter — Claude Code ACP integration
// ============================================================================

import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { AcpBaseAdapter } from "./acp-base-adapter";
import type {
  EngineType,
  EngineCapabilities,
} from "../../../src/types/unified";

function findBinary(name: string): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    join(homedir(), ".local", "bin", name + ext),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return name; // fallback to PATH
}

export class ClaudeAdapter extends AcpBaseAdapter {
  readonly engineType: EngineType = "claude";

  private binaryPath: string;

  constructor(options?: { binaryPath?: string }) {
    super();
    this.binaryPath = options?.binaryPath ?? findBinary("claude");
  }

  protected getBinary(): string {
    return this.binaryPath;
  }

  protected getArgs(): string[] {
    // Claude Code uses "acp" (no double dash) as the ACP mode argument
    return ["acp"];
  }

  getCapabilities(): EngineCapabilities {
    return {
      providerModelHierarchy: false,
      dynamicModes: true,
      messageCancellation: true,
      permissionAlways: false,
      imageAttachment: true,
      loadSession: true,
      listSessions: false,
      availableModes: this.getModes(),
    };
  }
}
