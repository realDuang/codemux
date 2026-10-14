import type { LocalServerState } from "../../shared/local-server-types";

export interface LocalServerView {
  state: LocalServerState;
  hasBeenReady: boolean;
  managerVisible: boolean;
}

export const initialLocalServerView: LocalServerView = {
  state: { phase: "starting", ownership: null, pid: null, error: null },
  hasBeenReady: false,
  managerVisible: true,
};

export function receiveLocalServerState(view: LocalServerView, state: LocalServerState): LocalServerView {
  return {
    state,
    // Keep mounted business state, including image drafts, through a host restart.
    hasBeenReady: view.hasBeenReady || state.phase === "ready",
    managerVisible: state.phase === "ready"
      ? view.state.phase === "ready" && view.managerVisible
      : view.managerVisible || view.state.phase !== state.phase,
  };
}

type RuntimeAPI = NonNullable<NonNullable<Window["electronAPI"]>["runtime"]>;
export type LocalServerAction = "start" | "stop" | "restart";

/** Subscribe before querying so a delayed snapshot cannot overwrite a newer event. */
export function observeLocalServer(
  api: Pick<RuntimeAPI, "getState" | "onStateChange" | LocalServerAction>,
  onState: (state: LocalServerState) => void,
  onError: (error: unknown) => void,
) {
  let revision = 0;
  let disposed = false;
  const unsubscribe = api.onStateChange((state) => {
    if (disposed) return;
    revision += 1;
    onState(state);
  });

  void api.getState().then((state) => {
    if (!disposed && revision === 0) onState(state);
  }).catch((error: unknown) => {
    if (!disposed && revision === 0) onError(error);
  });

  return {
    async run(action: LocalServerAction): Promise<void> {
      const requestRevision = ++revision;
      const state = await api[action]();
      if (!disposed && revision === requestRevision) onState(state);
    },
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}
