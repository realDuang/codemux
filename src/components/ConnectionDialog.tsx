import { createUniqueId, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { useI18n } from "../lib/i18n";

interface ConnectionDialogProps {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: JSX.Element;
}

export function ConnectionDialog(props: ConnectionDialogProps) {
  const { t } = useI18n();
  const id = createUniqueId();
  let dialog: HTMLElement | undefined;
  onMount(() => {
    const previousFocus = document.activeElement;
    dialog?.focus();
    onCleanup(() => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    });
  });
  const handleKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      if (!props.busy) props.onClose();
    } else if (event.key === "Tab") {
      const controls = dialog?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex='0']");
      if (!controls?.length) { event.preventDefault(); return; }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
  };
  return (
    <Portal>
      <div class="fixed inset-0 z-[10010] flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => { if (!props.busy) props.onClose(); }} aria-hidden="true" />
        <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={handleKeyDown}
          class="relative flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)] shadow-[var(--cm-shadow-lg)] outline-none">
          <header class="flex items-center justify-between gap-4 border-b border-[var(--cm-hairline)] px-5 py-4">
            <h2 id={`${id}-title`} class="text-base font-semibold text-[var(--cm-text)]">{props.title}</h2>
            <button type="button" onClick={() => props.onClose()} disabled={props.busy} aria-label={t().hostConnections.close}
              class="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--cm-text-muted)] hover:bg-[var(--cm-surface-3)] disabled:opacity-40">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
            </button>
          </header>
          <div class="overflow-y-auto p-5">{props.children}</div>
        </section>
      </div>
    </Portal>
  );
}
