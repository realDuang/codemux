import { Show, createEffect, createMemo, createResource, createSignal, on } from "solid-js";
import { isAcceptedImageMime, MAX_IMAGE_SIZE_BYTES } from "../../../shared/image-limits";
import { gateway } from "../../lib/gateway-api";
import { useI18n } from "../../lib/i18n";
import type { FilePart, UnifiedMessage } from "../../types/unified";
import styles from "./AttachmentContent.module.css";

interface AttachmentContentProps {
  part: FilePart;
  message: UnifiedMessage;
}

function safeAttachmentUrl(value: string, image: boolean): string | undefined {
  if (image && value.length <= Math.ceil(MAX_IMAGE_SIZE_BYTES / 3) * 4 + 128
    && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
  if (value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export default function AttachmentContent(props: AttachmentContentProps) {
  const { t } = useI18n();
  const [loadedUrl, setLoadedUrl] = createSignal<string>();
  const [failedUrl, setFailedUrl] = createSignal<string>();
  const image = createMemo(() => isAcceptedImageMime(props.part.mime));
  const directUrl = createMemo(() => safeAttachmentUrl(props.part.url, image()));
  const externalUrl = createMemo(() => directUrl()?.startsWith("https:") ? directUrl() : undefined);
  const [localImage] = createResource(
    () => image() && !directUrl() && props.part.sourcePath && props.message.workingDirectory
      ? { path: props.part.sourcePath, directory: props.message.workingDirectory }
      : undefined,
    async ({ path, directory }) => {
      try {
        // The existing file gateway enforces the workspace boundary for remote clients.
        const file = await gateway.readFile(path, directory);
        if (!file.binary || file.size > MAX_IMAGE_SIZE_BYTES || !file.mimeType || !isAcceptedImageMime(file.mimeType)) return undefined;
        return { path, directory, url: safeAttachmentUrl(`data:${file.mimeType};base64,${file.content}`, true) };
      } catch {
        return undefined;
      }
    },
  );
  const imageUrl = createMemo(() => {
    if (!image()) return undefined;
    if (directUrl()) return directUrl();
    const local = localImage.latest;
    return local && local.path === props.part.sourcePath && local.directory === props.message.workingDirectory
      ? local.url : undefined;
  });
  createEffect(on(imageUrl, () => {
    setLoadedUrl(undefined);
    setFailedUrl(undefined);
  }));
  const loaded = createMemo(() => !!imageUrl() && imageUrl() === loadedUrl());
  const unavailable = createMemo(() => imageUrl()
    ? imageUrl() === failedUrl()
    : !localImage.loading);

  return (
    <figure class={styles.root} data-component="attachment" data-image={image() ? "" : undefined}>
      <Show when={image()}>
        <div class={styles.preview} aria-busy={!loaded() && !unavailable()}>
          <Show when={imageUrl()} keyed>
            {(url) => (
              <img
                class={styles.image}
                classList={{ [styles.loaded]: loaded() }}
                src={url}
                alt={props.part.filename}
                loading="lazy"
                referrerpolicy="no-referrer"
                onLoad={() => setLoadedUrl(url)}
                onError={() => setFailedUrl(url)}
              />
            )}
          </Show>
          <Show when={!loaded()}>
            <div class={styles.state} role="status">
              {unavailable() ? t().markdown.imageUnavailable : t().common.loading}
            </div>
          </Show>
        </div>
      </Show>
      <figcaption class={styles.caption}>
        <svg class={styles.icon} aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
          <path d="M14 2v6h6" />
        </svg>
        <div class={styles.description}>
          <Show when={externalUrl()} fallback={<span class={styles.filename}>{props.part.filename}</span>}>
            <a class={styles.filename} href={externalUrl()} target="_blank" rel="noopener noreferrer">{props.part.filename}</a>
          </Show>
          <span class={styles.label}>{t().parts.attachment}</span>
        </div>
      </figcaption>
    </figure>
  );
}
