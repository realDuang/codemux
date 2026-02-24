// ============================================================================
// Copilot CLI Adapter — GitHub Copilot CLI ACP integration
// ============================================================================

import { AcpBaseAdapter } from "./acp-base-adapter";
import type {
  EngineType,
  EngineCapabilities,
} from "../../../src/types/unified";

export class CopilotAdapter extends AcpBaseAdapter {
  readonly engineType: EngineType = "copilot";

  private binaryPath: string;

  constructor(options?: { binaryPath?: string }) {
    super();
    this.binaryPath = options?.binaryPath ?? "copilot";
  }

  protected getBinary(): string {
    return this.binaryPath;
  }

  protected getArgs(): string[] {
    return ["--acp"];
  }

  getCapabilities(): EngineCapabilities {
    return {
      providerModelHierarchy: false,
      dynamicModes: true,
      messageCancellation: true,
      permissionAlways: true,
      imageAttachment: true,
      loadSession: true,
      listSessions: true,
      availableModes: this.getModes(),
    };
  }
}
