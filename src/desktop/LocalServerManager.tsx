import { onCleanup, onMount, Show } from "solid-js";
import type { LocalServerState } from "../../shared/local-server-types";
import { Spinner } from "../components/Spinner";
import { formatMessage, useI18n } from "../lib/i18n";
import { publicAssetUrl } from "../lib/public-assets";
import type { LocalServerAction } from "./local-server-state";

interface LocalServerManagerProps {
  state: LocalServerState;
  canClose: boolean;
  pending: boolean;
  actionError: string | null;
  onAction: (action: LocalServerAction) => void;
  onClose: () => void;
  onOpenLogs: () => void;
}

export function LocalServerManager(props: LocalServerManagerProps) {
  const { t } = useI18n();
  let dialog: HTMLElement | undefined;
  const isBusy = () => props.pending || props.state.phase === "starting" || props.state.phase === "stopping";
  const isExternal = () => props.state.ownership === "external";

  onMount(() => {
    const previousFocus = document.activeElement;
    dialog?.focus();
    onCleanup(() => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    });
  });

  const handleKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape" && props.canClose) {
      event.preventDefault();
      props.onClose();
    } else if (event.key === "Tab") {
      const buttons = dialog?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      if (!buttons?.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div class="fixed inset-0 z-[9999] flex items-center justify-center bg-gray-50/95 dark:bg-slate-950/95 electron-safe-top p-6 overflow-y-auto">
      <section
        ref={dialog}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="local-server-title"
        onKeyDown={handleKeyDown}
        class="w-full max-w-lg rounded-xl border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)] p-6 shadow-[var(--cm-shadow-lg)] outline-none"
      >
        <div class="flex items-center gap-3 mb-5">
          <img src={publicAssetUrl("logo.png")} alt="" class="h-10 w-10 object-contain" />
          <div>
            <h1 id="local-server-title" class="text-lg font-semibold text-gray-900 dark:text-white">{t().localServer.title}</h1>
            <p class="text-sm text-gray-500 dark:text-gray-400">{t().localServer.description}</p>
          </div>
        </div>

        <div role="status" class="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-200">
          <Show when={isBusy()}><Spinner size="small" class="text-blue-500" /></Show>
          <span>{t().localServer[props.state.phase]}</span>
          <Show when={props.state.pid !== null}>
            <span class="font-normal text-gray-500 dark:text-gray-400">{formatMessage(t().localServer.process, { pid: props.state.pid ?? "" })}</span>
          </Show>
        </div>
        <Show when={isExternal()}>
          <p class="mt-3 text-sm text-gray-500 dark:text-gray-400">{t().localServer.external}</p>
        </Show>
        <Show when={props.state.error || props.actionError}>
          <p role="alert" class="mt-4 whitespace-pre-wrap break-words rounded-lg bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300">
            {props.actionError || props.state.error}
          </p>
        </Show>

        <div class="mt-6 flex flex-wrap items-center gap-2">
          <Show when={props.state.phase === "stopped" || props.state.phase === "error"}>
            <button
              type="button"
              disabled={isBusy()}
              onClick={() => props.onAction("start")}
              class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >{t().localServer.start}</button>
          </Show>
          <Show when={props.state.phase === "ready"}>
            <button
              type="button"
              disabled={isBusy() || isExternal()}
              onClick={() => { if (!isExternal()) props.onAction("restart"); }}
              class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >{t().localServer.restart}</button>
            <button
              type="button"
              disabled={isBusy()}
              onClick={() => props.onAction("stop")}
              class="rounded-lg border border-[var(--cm-hairline-strong)] px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >{t().localServer.stop}</button>
          </Show>
          <button
            type="button"
            onClick={() => props.onOpenLogs()}
            class="rounded-lg border border-[var(--cm-hairline-strong)] px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-800"
          >{t().localServer.openLogs}</button>
        </div>
        <Show when={props.canClose}>
          <div class="mt-5 border-t border-[var(--cm-hairline-strong)] pt-4">
            <Show when={props.state.phase !== "ready"}>
              <p class="mb-3 text-sm text-gray-500 dark:text-gray-400">{t().localServer.editingHint}</p>
            </Show>
            <button type="button" onClick={() => props.onClose()} class="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
              {t().localServer.returnToApp}
            </button>
          </div>
        </Show>
      </section>
    </div>
  );
}
