import type { SessionSourceState } from "../../../src/types/unified";

export interface SessionSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): SessionSourceState;
  setEnabled(enabled: boolean): Promise<SessionSourceState>;
}
