import { Show, createMemo, onCleanup, onMount } from "solid-js";
import { formatMessage, useI18n } from "../lib/i18n";
import type { UnifiedSession } from "../types/unified";

interface SessionConnectionProps {
  connection?: UnifiedSession["connection"];
}

export function SessionOriginBadge(props: SessionConnectionProps) {
  const { t } = useI18n();
  return (
    <Show when={props.connection?.origin}>
      {(origin) => (
        <span
          class="max-w-[100px] truncate text-[9px] leading-none text-[var(--cm-text-muted)]"
          title={formatMessage(t().sessionSharing.createdIn, { origin: origin() })}
          data-session-origin
        >
          {origin()}
        </span>
      )}
    </Show>
  );
}

export function SessionConnectionDetails(props: SessionConnectionProps) {
  const { t } = useI18n();
  let details: HTMLDetailsElement | undefined;
  const sharingStatus = createMemo(() => props.connection?.sharingStatus
    ?? (!props.connection?.available ? "unavailable" : props.connection.shared ? "connected" : "disabled"));
  const sharingLabel = createMemo(() => {
    const labels = t().sessionSharing;
    switch (sharingStatus()) {
      case "connected": return props.connection?.shared && props.connection.available ? labels.shared : labels.enabled;
      case "connecting": return labels.connecting;
      case "disabled": return labels.notShared;
      case "unavailable": return labels.unavailable;
    }
  });

  onMount(() => {
    const handleOutsidePress = (event: PointerEvent) => {
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    document.addEventListener("pointerdown", handleOutsidePress);
    onCleanup(() => document.removeEventListener("pointerdown", handleOutsidePress));
  });

  return (
    <Show when={props.connection}>
      {(connection) => (
        <details
          ref={details}
          class="shrink-0 electron-no-drag"
          onKeyDown={(event) => {
            if (event.key === "Escape" && details?.open) {
              details.open = false;
              details.querySelector("summary")?.focus();
              event.stopPropagation();
            }
          }}
        >
          <summary
            class="flex min-h-6 min-w-6 cursor-pointer list-none items-center justify-center gap-1 rounded-md px-1.5 py-[1px] text-[10px] text-[var(--cm-text-muted)] hover:bg-[var(--cm-surface-3)] focus-visible:outline-2 focus-visible:outline-[var(--cm-accent)] [&::-webkit-details-marker]:hidden"
            aria-label={t().sessionSharing.details}
            title={t().sessionSharing.details}
            data-session-connection
          >
            <span class={`h-1.5 w-1.5 rounded-full ${sharingStatus() === "unavailable" ? "bg-amber-500" : sharingStatus() === "connected" ? "bg-emerald-500" : "bg-[var(--cm-text-faint)]"}`} />
            <span class="hidden sm:inline">{sharingLabel()}</span>
            <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 10 5 5 5-5" /></svg>
          </summary>
          <div
            class="fixed left-1/2 z-50 mt-2 w-[min(320px,calc(100vw-32px))] -translate-x-1/2 rounded-xl border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] p-4 shadow-[var(--cm-shadow-lg)]"
            role="region"
            aria-label={t().sessionSharing.details}
          >
            <p class="mb-3 text-xs font-medium text-[var(--cm-text)]">{t().sessionSharing.details}</p>
            <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
              <dt class="text-[var(--cm-text-muted)]">{t().sessionSharing.origin}</dt>
              <dd class="break-words text-right text-[var(--cm-text)]">{connection().origin || t().sessionSharing.unknownOrigin}</dd>
              <dt class="text-[var(--cm-text-muted)]">{t().sessionSharing.executor}</dt>
              <dd class="break-words text-right text-[var(--cm-text)]">{connection().executor || t().sessionSharing.unknownExecutor}</dd>
              <dt class="text-[var(--cm-text-muted)]">{t().sessionSharing.connection}</dt>
              <dd class="text-right text-[var(--cm-text)]">{sharingLabel()}</dd>
              <dt class="text-[var(--cm-text-muted)]">{t().sessionSharing.liveConnection}</dt>
              <dd class="text-right text-[var(--cm-text)]">
                <Show when={connection().available} fallback={t().sessionSharing.awaitingConnection}>
                  {t().sessionSharing.connected}
                </Show>
              </dd>
              <Show when={connection().runtimeVersion}>
                {(version) => (
                  <>
                    <dt class="text-[var(--cm-text-muted)]">{t().sessionSharing.runtimeVersion}</dt>
                    <dd class="cm-mono break-all text-right text-[var(--cm-text)]">{version()}</dd>
                  </>
                )}
              </Show>
            </dl>
          </div>
        </details>
      )}
    </Show>
  );
}
