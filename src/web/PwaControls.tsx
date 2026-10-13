import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { useI18n } from "../lib/i18n";
import { sessionStore } from "../stores/session";
import { createPwaController } from "./pwa";

export function PwaControls() {
  const { t } = useI18n();
  const [online, setOnline] = createSignal(navigator.onLine);
  const [installDismissed, setInstallDismissed] = createSignal(false);
  const [updateDismissed, setUpdateDismissed] = createSignal(false);
  let installDialog: HTMLDialogElement | undefined;
  const updateBlockReason = createMemo(() => {
    if (Object.values(sessionStore.inputDrafts).some((draft) => draft.images.length > 0)) return t().pwa.updateImages;
    if (Object.values(sessionStore.inputDraftSaveFailures).some(Boolean)) return t().pwa.updateUnsaved;
    if (Object.values(sessionStore.sendingMap).some(Boolean)) return t().pwa.updateBusy;
    return "";
  });
  const pwa = createPwaController(() => online() && !updateBlockReason());

  onMount(() => {
    const stop = pwa.start();
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    onCleanup(() => {
      stop();
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    });
  });

  return (
    <>
      <div class="web-status-area">
        <Show when={!online()}>
          <div class="web-status-bar web-status-offline" role="status">{t().pwa.offline}</div>
        </Show>
        <Show when={online() && pwa.updateAvailable() && !updateDismissed()} fallback={
          <Show when={pwa.canInstall() && !installDismissed()}>
            <div class="web-status-bar">
              <span class="web-status-copy">{t().pwa.installDescription}</span>
              <button class="web-status-action" onClick={() => pwa.ios ? installDialog?.showModal() : void pwa.install()}>{t().pwa.install}</button>
              <button class="web-status-dismiss" aria-label={t().pwa.dismiss} onClick={() => setInstallDismissed(true)}>×</button>
            </div>
          </Show>
        }>
          <div class="web-status-bar" role="status">
            <span class="web-status-copy">{pwa.updateFailed() ? t().pwa.updateFailed : updateBlockReason() || t().pwa.updateAvailable}</span>
            <button class="web-status-action" disabled={Boolean(updateBlockReason()) || pwa.updating()} onClick={() => { if (!updateBlockReason()) void pwa.update(); }}>{t().pwa.update}</button>
            <button class="web-status-dismiss" aria-label={t().pwa.dismiss} onClick={() => setUpdateDismissed(true)}>×</button>
          </div>
        </Show>
      </div>
      <dialog ref={installDialog} class="web-install-dialog" aria-labelledby="web-install-title" onClick={(event) => { if (event.target === event.currentTarget) installDialog?.close(); }}>
        <div class="web-install-content">
          <img src="/assets/apple-touch-icon.png" width="56" height="56" alt="" />
          <h2 id="web-install-title">{t().pwa.installTitle}</h2>
          <p>{t().pwa.installIos}</p>
          <p class="web-install-note">{t().pwa.installIosBrowser}</p>
          <form method="dialog"><button class="web-status-action">{t().pwa.done}</button></form>
        </div>
      </dialog>
    </>
  );
}
