export type LocalServerPhase = "stopped" | "starting" | "ready" | "stopping" | "error";

/** Desktop-visible status only; control credentials never enter the renderer. */
export interface LocalServerState {
  phase: LocalServerPhase;
  ownership: "owned" | "external" | null;
  pid: number | null;
  error: string | null;
}
