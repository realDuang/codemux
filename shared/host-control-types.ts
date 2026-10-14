export interface HostRuntimeStatus {
  pid: number;
  /** The local desktop that owns this child, absent for an independent server. */
  desktopParentPid?: number;
  /** The development launcher that owns this child, absent for an independent server. */
  developmentParentPid?: number;
  phase: "starting" | "ready" | "stopping";
  ready: boolean;
  dataPath: string;
  webPort: number | null;
  gatewayUrl: string | null;
}

/** Private discovery data for processes running as the runtime's local owner. */
export interface HostControlMetadata {
  version: 1;
  instanceId: string;
  pid: number;
  port: number;
  dataPath: string;
  ownerCredential: string;
}

export const HOST_CONTROL_FILENAME = "runtime-control.json";

export type HostControlErrorCode =
  | "NOT_RUNNING"
  | "INVALID_METADATA"
  | "UNAVAILABLE"
  | "INSTANCE_CHANGED"
  | "UNAUTHORIZED"
  | "REQUEST_FAILED";

export class HostControlError extends Error {
  constructor(readonly code: HostControlErrorCode, message: string) {
    super(message);
    this.name = "HostControlError";
  }
}
