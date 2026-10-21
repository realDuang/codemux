import { Show, type JSX } from "solid-js";
import { useI18n } from "../lib/i18n";

export type ChannelRunState = "running" | "starting" | "error" | "stopped";

interface ChannelCardProps {
  icon: JSX.Element;
  name: string;
  description: string;
  state: ChannelRunState;
  /** Secondary actions such as Configure, Login or Logout. */
  actions?: JSX.Element;
  enabled: boolean;
  toggleDisabled?: boolean;
  toggleTitle?: string;
  onToggle: () => void;
  error?: string;
  /** Extra details shown below the row, e.g. a webhook endpoint. */
  details?: JSX.Element;
}

/** Secondary button style shared with the remote connection cards. */
export const channelButtonClass = "min-h-8 shrink-0 rounded-lg border border-[var(--cm-hairline-strong)] px-3 text-xs font-medium text-[var(--cm-text)] hover:bg-[var(--cm-surface-2)] disabled:cursor-not-allowed disabled:opacity-40";

/** One messaging channel row, styled like a saved remote connection. */
export function ChannelCard(props: ChannelCardProps) {
  const { t } = useI18n();
  const stateLabel = () => ({
    running: t().channel.stateRunning,
    starting: t().channel.stateStarting,
    error: t().channel.stateError,
    stopped: t().channel.stateStopped,
  })[props.state];
  return (
    <div class="p-4" data-testid="channel-card">
      <div class="flex flex-wrap items-center gap-3 sm:flex-nowrap">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--cm-surface-2)] text-[var(--cm-text-muted)]">{props.icon}</span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p class="truncate text-sm font-medium text-[var(--cm-text)]">{props.name}</p>
            <span role="status" class="flex items-center gap-1.5 text-[11px] text-[var(--cm-text-muted)]">
              <span aria-hidden="true" class={`h-1.5 w-1.5 rounded-full ${props.state === "running" ? "bg-emerald-500" : props.state === "error" ? "bg-red-500" : props.state === "starting" ? "animate-pulse bg-amber-500" : "bg-gray-400"}`} />
              {stateLabel()}
            </span>
          </div>
          <p class="mt-1 text-xs leading-relaxed text-[var(--cm-text-muted)]">{props.description}</p>
        </div>
        <div class="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
          {props.actions}
          <button
            type="button"
            role="switch"
            aria-checked={props.enabled}
            aria-label={props.name}
            title={props.toggleTitle}
            onClick={() => props.onToggle()}
            disabled={props.toggleDisabled}
            class={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-500 disabled:cursor-not-allowed disabled:opacity-40 ${props.enabled ? "bg-[var(--cm-accent)]" : "bg-black/20 dark:bg-white/20"}`}
          >
            <span aria-hidden="true" class={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${props.enabled ? "translate-x-[18px]" : "translate-x-0.5"}`} />
          </button>
        </div>
      </div>
      <Show when={props.error}>
        <p role="alert" class="mt-3 break-words text-xs text-red-600 dark:text-red-400">{props.error}</p>
      </Show>
      <Show when={props.details}>
        <div class="mt-3 border-t border-[var(--cm-hairline)] pt-3">{props.details}</div>
      </Show>
    </div>
  );
}
