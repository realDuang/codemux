import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import QRCode from "qrcode";
import { useI18n } from "../lib/i18n";

interface AccessQRCodeProps {
  url: string;
}

export function AccessQRCode(props: AccessQRCodeProps) {
  const { t } = useI18n();
  const [imageUrl, setImageUrl] = createSignal("");
  const [failed, setFailed] = createSignal(false);

  createEffect(() => {
    const url = props.url;
    let active = true;
    setImageUrl("");
    setFailed(false);
    onCleanup(() => { active = false; });

    void QRCode.toDataURL(url, { width: 200, margin: 1 }).then(
      (dataUrl) => { if (active) setImageUrl(dataUrl); },
      () => { if (active) setFailed(true); },
    );
  });

  return (
    <Show when={imageUrl()} fallback={
      <div class="w-44 h-44 flex items-center justify-center text-gray-500 text-xs text-center" role="status">
        <Show when={failed()} fallback={t().common.loading}>{t().remote.accessQrError}</Show>
      </div>
    }>
      <img src={imageUrl()} alt={t().remote.accessQrAlt} class="w-44 h-44 object-contain" />
    </Show>
  );
}
