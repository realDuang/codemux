import { copyTextToClipboard } from "./clipboard";
import { gateway } from "./gateway-api";
import { fileStore, openPanel, previewFile, setRootDirectory } from "../stores/file";
import { isLocalMarkdownReference } from "./markdown-stream";
import { isAcceptedImageMime, MAX_IMAGE_SIZE_BYTES, MAX_IMAGES_PER_MESSAGE } from "../../shared/image-limits";
import type { FilePart } from "../types/unified";

export interface MarkdownInteractionOptions {
  workingDirectory?: string;
  inlineAssets?: FilePart[];
  labels: {
    copyTable: string;
    copied: string;
    copyFailed: string;
    tableRegion: string;
    expandTable: string;
    closeTable: string;
    tableDialog: string;
    scrollHorizontally: string;
    imageUnavailable: string;
    previewImage?: string;
    closeImage?: string;
    mediaUnavailable?: string;
  };
}

interface LocalMarkdownPath {
  absolutePath: string;
  relativePath: string;
  line?: number;
}

function normalizePath(value: string): string | undefined {
  const path = value.replace(/\\/g, "/");
  const prefix = /^[a-z]:\//i.exec(path)?.[0] ?? (path.startsWith("/") ? "/" : undefined);
  if (!prefix) return;
  const segments: string[] = [];
  for (const segment of path.slice(prefix.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return prefix + segments.join("/");
}

/** Client checks are supplementary; the gateway also enforces the realpath boundary. */
export function resolveLocalMarkdownPath(value: string, directory?: string): LocalMarkdownPath | undefined {
  if (!directory || !isLocalMarkdownReference(value)) return;
  let path: string;
  try {
    if (/^file:/i.test(value)) {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return;
      path = decodeURIComponent(url.pathname) + url.hash;
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } else path = decodeURIComponent(value);
  } catch { return; }
  if (/[\u0000-\u001f\u007f]/.test(path)) return;
  const location = /(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/.exec(path);
  const line = location ? Number(location[1] ?? location[2]) : undefined;
  if (location) path = path.slice(0, location.index);
  const root = normalizePath(directory);
  if (!root) return;
  const absolutePath = normalizePath(/^(?:\/|[a-z]:[\\/])/i.test(path) ? path : `${root}/${path}`);
  if (!absolutePath) return;
  const compare = (candidate: string) => /^[a-z]:/i.test(root) ? candidate.toLowerCase() : candidate;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!compare(absolutePath).startsWith(compare(prefix))) return;
  return {
    absolutePath,
    relativePath: absolutePath.slice(prefix.length),
    ...(line && Number.isSafeInteger(line) ? { line } : {}),
  };
}

const DECORATIONS = 'button, script, style, [hidden], [aria-hidden="true"], [data-component="decoration"], [data-markdown-decoration]';

export function getMarkdownTableClipboard(table: HTMLTableElement): { text: string; html: string } {
  const clone = table.cloneNode(true) as HTMLTableElement;
  clone.querySelectorAll(DECORATIONS).forEach((element) => element.remove());
  const html = clone.outerHTML;
  const text = Array.from(clone.rows, (row) => Array.from(row.cells, (cell) => {
    cell.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    const value = (cell.textContent ?? "").trim();
    return /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }).join("\t")).join("\n");
  return { text, html };
}

const IMAGE_MIMES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp", "image/x-icon",
  "image/tiff", "image/avif", "image/heic", "image/svg+xml",
]);
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|bmp|webp|ico|tiff?|avif|heic|svg)$/i;

function inlineImageUrl(source: string, assets?: FilePart[]): string | undefined {
  const asset = assets?.slice(0, MAX_IMAGES_PER_MESSAGE).find((candidate) => candidate.sourcePath === source);
  if (!asset || !isAcceptedImageMime(asset.mime) || !asset.url.startsWith(`data:${asset.mime};base64,`)) return;
  const data = asset.url.slice(`data:${asset.mime};base64,`.length);
  if (data.length > Math.ceil(MAX_IMAGE_SIZE_BYTES / 3) * 4 || !data.length || data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return;
  return asset.url;
}

interface ImageLoad { source: string; directory?: string; inlineUrl?: string }

/** Wrap before block reconciliation so the wrapper shares the table's stable identity. */
export function prepareMarkdownTables(container: ParentNode): void {
  container.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    if (table.parentElement?.hasAttribute("data-markdown-table-scroll")) return;
    const frame = document.createElement("div");
    frame.setAttribute("data-markdown-table-frame", "");
    const scroll = document.createElement("div");
    scroll.setAttribute("data-markdown-table-scroll", "");
    table.replaceWith(frame);
    frame.appendChild(scroll);
    scroll.appendChild(table);
  });
}

interface Enhancement {
  options: MarkdownInteractionOptions;
  refresh: () => void;
  cleanup: () => void;
}
const enhancements = new WeakMap<HTMLElement, Enhancement>();

/** Repeated calls enhance new blocks while preserving the existing DOM and focus. */
export function enhanceMarkdownInteractions(root: HTMLElement, options: MarkdownInteractionOptions): () => void {
  const existing = enhancements.get(root);
  if (existing) {
    existing.options = options;
    existing.refresh();
    return existing.cleanup;
  }
  let disposed = false;
  const timers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();
  const imageFallbacks = new WeakMap<HTMLElement, HTMLElement>();
  const imageLoads = new WeakMap<HTMLImageElement, ImageLoad>();
  const scrollRegions = new Set<HTMLElement>();
  const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateOverflow);
  let expandedTable: { dialog: HTMLDialogElement; table: HTMLTableElement; trigger: HTMLButtonElement } | undefined;
  let expandedImage: { dialog: HTMLDialogElement; trigger: HTMLImageElement; source: string; url: string } | undefined;
  const state: Enhancement = { options, refresh, cleanup };
  enhancements.set(root, state);

  async function handleClick(event: MouseEvent) {
    if (event.type === "auxclick" && event.button !== 1) return;
    const target = event.target instanceof Element ? event.target : null;
    const previewImage = target?.closest<HTMLImageElement>("img[data-inline-asset]");
    if (previewImage && root.contains(previewImage) && event.type !== "auxclick") {
      event.preventDefault();
      openImage(previewImage);
      return;
    }
    const closePreview = target?.closest<HTMLButtonElement>("button[data-markdown-close-image]");
    if (closePreview && root.contains(closePreview)) {
      event.preventDefault();
      closeImage();
      return;
    }
    const copy = target?.closest<HTMLButtonElement>('button[data-markdown-copy-table]');
    if (copy && root.contains(copy)) {
      event.preventDefault();
      const table = copy.closest("[data-markdown-table-frame], [data-markdown-table-dialog]")?.querySelector("table");
      if (!table) return;
      const contents = getMarkdownTableClipboard(table);
      const success = await copyTextToClipboard(contents.text, contents.html);
      if (disposed || !root.contains(copy)) return;
      copy.setAttribute("data-copy-state", success ? "copied" : "copyFailed");
      copy.textContent = success ? state.options.labels.copied : state.options.labels.copyFailed;
      if (timers.has(copy)) clearTimeout(timers.get(copy));
      const timer = setTimeout(() => {
        timers.delete(copy);
        copy.removeAttribute("data-copy-state");
        copy.textContent = state.options.labels.copyTable;
      }, 2000);
      timers.set(copy, timer);
      return;
    }
    const expand = target?.closest<HTMLButtonElement>("button[data-markdown-expand-table]");
    if (expand && root.contains(expand)) {
      event.preventDefault();
      const table = expand.closest("[data-markdown-table-frame]")?.querySelector("table");
      if (table) openTable(table, expand);
      return;
    }
    const close = target?.closest<HTMLButtonElement>("button[data-markdown-close-table]");
    if (close && root.contains(close)) {
      event.preventDefault();
      closeTable();
      return;
    }
    const link = target?.closest<HTMLAnchorElement>("a[href]");
    const href = link?.getAttribute("data-local-href") ?? link?.getAttribute("href");
    if (!link || !href || !root.contains(link) || !isLocalMarkdownReference(href)) return;
    event.preventDefault();
    const directory = state.options.workingDirectory;
    const path = resolveLocalMarkdownPath(href, directory);
    if (!path || !directory) return;
    openPanel();
    // Mounting the explorer initializes its directory and clears old tabs.
    // Let that initialization run before selecting the linked file.
    await Promise.resolve();
    if (disposed || state.options.workingDirectory !== directory) return;
    if (fileStore.rootDirectory !== directory) await setRootDirectory(directory);
    if (disposed || fileStore.rootDirectory !== directory) return;
    await previewFile(path.absolutePath, path.relativePath.split("/").at(-1)!, path.relativePath, path.line);
  }

  function updateOverflow() {
    for (const region of scrollRegions) {
      if (!root.contains(region)) {
        resize?.unobserve(region);
        scrollRegions.delete(region);
        continue;
      }
      const frame = region.closest("[data-markdown-table-frame], [data-markdown-table-dialog]");
      frame?.toggleAttribute("data-overflow-start", region.scrollLeft > 1);
      frame?.toggleAttribute("data-overflow-end", region.scrollWidth - region.clientWidth - region.scrollLeft > 1);
    }
  }

  function prepareRegion(region: HTMLElement) {
    region.tabIndex = 0;
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", state.options.labels.tableRegion);
    if (!scrollRegions.has(region)) {
      scrollRegions.add(region);
      resize?.observe(region);
    }
  }

  function closeTable() {
    const current = expandedTable;
    if (!current) return;
    expandedTable = undefined;
    if (current.dialog.open && typeof current.dialog.close === "function") current.dialog.close();
    current.dialog.remove();
    if (current.trigger.isConnected) current.trigger.focus({ preventScroll: true });
  }

  function openTable(table: HTMLTableElement, trigger: HTMLButtonElement) {
    closeImage();
    closeTable();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("data-markdown-table-dialog", "");
    dialog.setAttribute("data-markdown-decoration", "");
    dialog.setAttribute("aria-label", state.options.labels.tableDialog);
    const toolbar = document.createElement("div");
    toolbar.setAttribute("data-markdown-table-toolbar", "");
    const title = document.createElement("strong");
    title.textContent = state.options.labels.tableDialog;
    const copy = tableButton("data-markdown-copy-table", state.options.labels.copyTable);
    const close = tableButton("data-markdown-close-table", state.options.labels.closeTable);
    toolbar.append(title, copy, close);
    const region = document.createElement("div");
    region.setAttribute("data-markdown-table-scroll", "");
    const clone = table.cloneNode(true) as HTMLTableElement;
    clone.querySelectorAll(DECORATIONS).forEach((element) => element.remove());
    region.appendChild(clone);
    dialog.append(toolbar, region);
    dialog.addEventListener("close", () => { if (expandedTable?.dialog === dialog) closeTable(); });
    // Native modal dialogs trap focus and handle Escape without global key handlers.
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeTable(); });
    root.appendChild(dialog);
    expandedTable = { dialog, table, trigger };
    prepareRegion(region);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    close.focus({ preventScroll: true });
    updateOverflow();
  }

  function tableButton(attribute: string, label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(attribute, "");
    button.setAttribute("data-markdown-decoration", "");
    button.textContent = label;
    if (attribute === "data-markdown-copy-table") button.setAttribute("aria-live", "polite");
    return button;
  }

  function setImagePreview(image: HTMLImageElement, enabled: boolean) {
    if (!enabled) {
      for (const attribute of ["data-inline-asset", "role", "tabindex", "aria-label", "aria-haspopup"]) image.removeAttribute(attribute);
      return;
    }
    image.setAttribute("data-inline-asset", "");
    image.setAttribute("role", "button");
    image.setAttribute("tabindex", "0");
    image.setAttribute("aria-haspopup", "dialog");
    image.setAttribute("aria-label", state.options.labels.previewImage ?? (image.alt || state.options.labels.imageUnavailable));
  }

  function closeImage(restoreFocus = true) {
    const current = expandedImage;
    if (!current) return;
    expandedImage = undefined;
    if (current.dialog.open && typeof current.dialog.close === "function") current.dialog.close();
    current.dialog.remove();
    if (restoreFocus && current.trigger.isConnected && root.contains(current.trigger) && !current.trigger.hidden) current.trigger.focus({ preventScroll: true });
  }

  function openImage(trigger: HTMLImageElement) {
    const source = trigger.getAttribute("data-local-src");
    const url = source ? inlineImageUrl(source, state.options.inlineAssets) : undefined;
    if (!source || !url || trigger.hidden || !root.contains(trigger)) return;
    closeTable();
    closeImage();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("data-markdown-image-dialog", "");
    dialog.setAttribute("data-markdown-decoration", "");
    dialog.setAttribute("aria-label", state.options.labels.previewImage ?? (trigger.alt || state.options.labels.imageUnavailable));
    const toolbar = document.createElement("div");
    toolbar.setAttribute("data-markdown-image-toolbar", "");
    const title = document.createElement("strong");
    title.textContent = trigger.alt;
    const close = tableButton("data-markdown-close-image", state.options.labels.closeImage ?? state.options.labels.closeTable);
    toolbar.append(title, close);
    const image = document.createElement("img");
    image.src = url;
    image.alt = trigger.alt;
    dialog.append(toolbar, image);
    dialog.addEventListener("close", () => { if (expandedImage?.dialog === dialog) closeImage(); });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeImage(); });
    root.appendChild(dialog);
    expandedImage = { dialog, trigger, source, url };
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    close.focus({ preventScroll: true });
  }

  function handleKeyDown(event: KeyboardEvent) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (event.key === "Escape" && expandedImage) {
      event.preventDefault();
      closeImage();
      return;
    }
    if (target.matches("img[data-inline-asset]") && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openImage(target as HTMLImageElement);
      return;
    }
    if (event.key === "Escape" && expandedTable) {
      event.preventDefault();
      closeTable();
      return;
    }
    if (!target.matches('[data-markdown-table-scroll]')) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const step = Math.max(40, target.clientWidth / 2);
    const next = event.key === "ArrowRight" ? target.scrollLeft + step
      : event.key === "ArrowLeft" ? target.scrollLeft - step
      : event.key === "Home" ? 0 : event.key === "End" ? target.scrollWidth : undefined;
    if (next === undefined) return;
    event.preventDefault();
    target.scrollLeft = next;
    updateOverflow();
  }

  async function loadImage(image: HTMLImageElement, load: ImageLoad) {
    const { source, directory, inlineUrl } = load;
    const current = () => !disposed && root.contains(image) && imageLoads.get(image) === load;
    const fail = () => {
      if (!current()) return;
      setImagePreview(image, false);
      if (expandedImage?.trigger === image) closeImage(false);
      const fallback = document.createElement("span");
      fallback.setAttribute("data-markdown-image-unavailable", "");
      fallback.textContent = image.alt || state.options.labels.imageUnavailable;
      imageFallbacks.get(image)?.remove();
      image.hidden = true;
      image.after(fallback);
      imageFallbacks.set(image, fallback);
    };
    if (inlineUrl) {
      image.addEventListener("error", fail, { once: true });
      image.src = inlineUrl;
      return;
    }
    const path = resolveLocalMarkdownPath(source, directory);
    if (!path || !directory || !IMAGE_EXTENSION.test(path.absolutePath)) { fail(); return; }
    try {
      const content = await gateway.readFile(path.absolutePath, directory);
      if (!current()) return;
      if (!content.content || !content.mimeType || !IMAGE_MIMES.has(content.mimeType)
        || (content.binary && !/^[A-Za-z0-9+/]*={0,2}$/.test(content.content))) { fail(); return; }
      image.addEventListener("error", fail, { once: true });
      if (!content.binary && content.mimeType !== "image/svg+xml") { fail(); return; }
      image.src = content.binary ? `data:${content.mimeType};base64,${content.content}`
        : `data:image/svg+xml,${encodeURIComponent(content.content)}`;
    } catch { fail(); }
  }

  async function loadMedia(media: HTMLMediaElement, source: string, directory: string) {
    const path = resolveLocalMarkdownPath(source, directory);
    const current = () => !disposed && root.contains(media) && media.getAttribute("data-local-loading") === directory;
    const fail = () => {
      if (!current()) return;
      const fallback = document.createElement("span");
      fallback.setAttribute("data-markdown-media-unavailable", "");
      fallback.textContent = media.getAttribute("aria-label") || state.options.labels.mediaUnavailable || state.options.labels.imageUnavailable;
      imageFallbacks.get(media)?.remove();
      media.hidden = true;
      media.after(fallback);
      imageFallbacks.set(media, fallback);
    };
    if (!path) { fail(); return; }
    try {
      const content = await gateway.readFile(path.absolutePath, directory);
      if (!current()) return;
      const prefix = media.tagName.toLowerCase() === "audio" ? "audio/" : "video/";
      if (!content.binary || !content.content || content.size > 10 * 1024 * 1024 || !content.mimeType?.startsWith(prefix)) { fail(); return; }
      media.addEventListener("error", fail, { once: true });
      media.src = `data:${content.mimeType};base64,${content.content}`;
    } catch { fail(); }
  }

  function refresh() {
    if (expandedTable && !root.contains(expandedTable.table)) closeTable();
    if (expandedImage) {
      if (!root.contains(expandedImage.trigger)
        || expandedImage.trigger.getAttribute("data-local-src") !== expandedImage.source
        || inlineImageUrl(expandedImage.source, state.options.inlineAssets) !== expandedImage.url) closeImage(false);
      else {
        expandedImage.dialog.setAttribute("aria-label", state.options.labels.previewImage ?? (expandedImage.trigger.alt || state.options.labels.imageUnavailable));
        expandedImage.dialog.querySelector("[data-markdown-close-image]")!.textContent = state.options.labels.closeImage ?? state.options.labels.closeTable;
      }
    }
    root.querySelectorAll<HTMLElement>("[data-markdown-table-frame]").forEach((frame) => {
      const table = frame.querySelector<HTMLTableElement>("table");
      const region = frame.querySelector<HTMLElement>("[data-markdown-table-scroll]");
      if (!table || !region) return;
      table.setAttribute("aria-label", state.options.labels.tableRegion);
      table.setAttribute("data-markdown-table", "");
      prepareRegion(region);
      if (!frame.querySelector("[data-markdown-table-toolbar]")) {
        const toolbar = document.createElement("div");
        toolbar.setAttribute("data-markdown-table-toolbar", "");
        toolbar.setAttribute("data-markdown-decoration", "");
        const hint = document.createElement("span");
        hint.setAttribute("data-table-overflow-hint", "");
        hint.setAttribute("aria-hidden", "true");
        toolbar.append(hint, tableButton("data-markdown-copy-table", state.options.labels.copyTable),
          tableButton("data-markdown-expand-table", state.options.labels.expandTable));
        frame.prepend(toolbar);
      }
      frame.querySelector("[data-table-overflow-hint]")!.textContent = state.options.labels.scrollHorizontally;
      frame.querySelector("[data-markdown-expand-table]")!.textContent = state.options.labels.expandTable;
    });
    root.querySelectorAll<HTMLButtonElement>("button[data-markdown-copy-table]").forEach((copy) => {
      const status = copy.getAttribute("data-copy-state");
      copy.textContent = status === "copied" ? state.options.labels.copied
        : status === "copyFailed" ? state.options.labels.copyFailed : state.options.labels.copyTable;
    });
    if (expandedTable) {
      expandedTable.dialog.setAttribute("aria-label", state.options.labels.tableDialog);
      expandedTable.dialog.querySelector("strong")!.textContent = state.options.labels.tableDialog;
      expandedTable.dialog.querySelector("[data-markdown-close-table]")!.textContent = state.options.labels.closeTable;
    }
    updateOverflow();
    root.querySelectorAll<HTMLImageElement>("img[data-local-src]").forEach((image) => {
      const source = image.getAttribute("data-local-src");
      const directory = state.options.workingDirectory;
      const inlineUrl = source ? inlineImageUrl(source, state.options.inlineAssets) : undefined;
      const previous = imageLoads.get(image);
      setImagePreview(image, !!inlineUrl && (!image.hidden || previous?.inlineUrl !== inlineUrl));
      const fallback = imageFallbacks.get(image);
      if (fallback && !image.alt) fallback.textContent = state.options.labels.imageUnavailable;
      if (!source) {
        imageLoads.delete(image);
        image.removeAttribute("src");
        fallback?.remove();
        image.hidden = true;
        return;
      }
      if ((!directory && !inlineUrl && !previous)
        || (previous?.source === source && previous.directory === directory && previous.inlineUrl === inlineUrl)) return;
      const load = { source, directory, inlineUrl };
      imageLoads.set(image, load);
      image.setAttribute("data-local-loading", directory ?? "");
      imageFallbacks.get(image)?.remove();
      image.hidden = false;
      image.removeAttribute("src");
      void loadImage(image, load);
    });
    root.querySelectorAll<HTMLMediaElement>("audio[data-local-src], video[data-local-src]").forEach((media) => {
      const source = media.getAttribute("data-local-src");
      const directory = state.options.workingDirectory;
      if (!source || !directory || media.getAttribute("data-local-loading") === directory) return;
      media.setAttribute("data-local-loading", directory);
      imageFallbacks.get(media)?.remove();
      media.hidden = false;
      media.removeAttribute("src");
      void loadMedia(media, source, directory);
    });
  }

  function cleanup() {
    disposed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    closeTable();
    closeImage(false);
    root.querySelectorAll<HTMLImageElement>("img[data-inline-asset]").forEach((image) => setImagePreview(image, false));
    resize?.disconnect();
    root.removeEventListener("scroll", updateOverflow, true);
    root.removeEventListener("click", handleClick);
    root.removeEventListener("auxclick", handleClick);
    root.removeEventListener("keydown", handleKeyDown);
    enhancements.delete(root);
  }
  root.addEventListener("scroll", updateOverflow, true);
  root.addEventListener("click", handleClick);
  root.addEventListener("auxclick", handleClick);
  root.addEventListener("keydown", handleKeyDown);
  refresh();
  return cleanup;
}

const ICON_COPY = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`
const ICON_CHECK = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
const ICON_WRAP = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h14a3 3 0 0 1 0 6h-4m3-3-3 3 3 3M3 18h4"/></svg>`

export interface MarkdownCodeLabels {
  codeRegion: string
  plainText: string
  copyCode: string
  copied: string
  copyFailed: string
  wrapCode: string
  unwrapCode: string
  scrollHorizontally: string
}

interface CodeEnhancement {
  labels: MarkdownCodeLabels
  refresh: () => void
  cleanup: () => void
}
const codeEnhancements = new WeakMap<HTMLElement, CodeEnhancement>()

/** Enhance retained code nodes without replacing their text, selection, or scroll position. */
export function attachCopyButtons(container: HTMLElement, labels: MarkdownCodeLabels): () => void {
  const existing = codeEnhancements.get(container)
  if (existing) {
    existing.labels = labels
    existing.refresh()
    return existing.cleanup
  }
  let disposed = false
  const timers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()
  const observed = new Set<HTMLElement>()
  const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => updateOverflow())
  const state: CodeEnhancement = { labels, refresh, cleanup }
  codeEnhancements.set(container, state)

  function updateOverflow() {
    for (const code of observed) {
      if (!container.contains(code)) {
        resize?.unobserve(code)
        observed.delete(code)
        continue
      }
      const pre = code.parentElement
      pre?.toggleAttribute("data-overflow-start", code.scrollLeft > 1)
      pre?.toggleAttribute("data-overflow-end", code.scrollWidth - code.clientWidth - code.scrollLeft > 1)
    }
  }

  function updateButtons(pre: HTMLPreElement) {
    const copy = pre.querySelector<HTMLButtonElement>("[data-markdown-copy-code]")!
    const wrap = pre.querySelector<HTMLButtonElement>("[data-markdown-wrap-code]")!
    const status = copy.getAttribute("data-copy-state")
    const copyLabel = status === "copied" ? state.labels.copied : status === "failed" ? state.labels.copyFailed : state.labels.copyCode
    copy.setAttribute("aria-label", copyLabel)
    copy.title = copyLabel
    copy.disabled = pre.hasAttribute("data-code-incomplete")
    copy.querySelector("[data-copy-label]")!.textContent = copyLabel
    copy.querySelector("[data-copy-announcement]")!.textContent = status ? copyLabel : ""
    const wrapped = pre.hasAttribute("data-code-wrap")
    const wrapLabel = wrapped ? state.labels.unwrapCode : state.labels.wrapCode
    wrap.setAttribute("aria-label", wrapLabel)
    wrap.setAttribute("aria-pressed", String(wrapped))
    wrap.title = wrapLabel
  }

  async function handleClick(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest<HTMLButtonElement>("[data-markdown-copy-code], [data-markdown-wrap-code]")
    const pre = button?.closest("pre")
    if (!button || !pre || !container.contains(pre)) return
    event.preventDefault()
    event.stopPropagation()
    if (button.hasAttribute("data-markdown-wrap-code")) {
      pre.toggleAttribute("data-code-wrap")
      updateButtons(pre)
      updateOverflow()
      return
    }
    if (pre.hasAttribute("data-code-incomplete")) return
    const code = pre.querySelector("code")
    const success = await copyTextToClipboard(code?.textContent ?? "")
    if (disposed || !container.contains(button)) return
    if (timers.has(button)) clearTimeout(timers.get(button))
    button.setAttribute("data-copy-state", success ? "copied" : "failed")
    button.toggleAttribute("data-copied", success)
    button.querySelector("[data-copy-icon]")!.innerHTML = success ? ICON_CHECK : ICON_COPY
    updateButtons(pre)
    timers.set(button, setTimeout(() => {
      timers.delete(button)
      button.removeAttribute("data-copy-state")
      button.removeAttribute("data-copied")
      button.querySelector("[data-copy-icon]")!.innerHTML = ICON_COPY
      updateButtons(pre)
    }, 2000))
  }

  function refresh() {
    container.querySelectorAll<HTMLPreElement>("pre").forEach(pre => {
      const code = pre.querySelector<HTMLElement>("code")
      if (!code) return
      pre.setAttribute("data-markdown-code", "")
      code.tabIndex = 0
      code.setAttribute("role", "region")
      code.setAttribute("aria-label", state.labels.codeRegion)
      if (!pre.querySelector("[data-markdown-code-toolbar]")) {
        const toolbar = document.createElement("div")
        toolbar.setAttribute("data-markdown-code-toolbar", "")
        toolbar.setAttribute("data-markdown-decoration", "")
        const language = document.createElement("span")
        language.setAttribute("data-code-language", "")
        const hint = document.createElement("span")
        hint.setAttribute("data-code-overflow-hint", "")
        hint.setAttribute("aria-hidden", "true")
        const wrap = document.createElement("button")
        wrap.type = "button"
        wrap.setAttribute("data-markdown-wrap-code", "")
        wrap.innerHTML = ICON_WRAP
        const copy = document.createElement("button")
        copy.type = "button"
        copy.setAttribute("data-markdown-copy-code", "")
        copy.innerHTML = `<span data-copy-icon>${ICON_COPY}</span><span data-copy-label></span><span data-copy-announcement role="status"></span>`
        toolbar.append(language, hint, wrap, copy)
        pre.prepend(toolbar)
      }
      const language = pre.getAttribute("data-code-language") ?? Array.from(code.classList).find(value => value.startsWith("language-"))?.slice(9)
      pre.querySelector("[data-code-language]")!.textContent = !language || /^(text|plaintext)$/.test(language) ? state.labels.plainText : language
      pre.querySelector("[data-code-overflow-hint]")!.textContent = state.labels.scrollHorizontally
      updateButtons(pre)
      if (!observed.has(code)) {
        observed.add(code)
        resize?.observe(code)
      }
    })
    updateOverflow()
  }

  function cleanup() {
    disposed = true
    for (const timer of timers.values()) clearTimeout(timer)
    resize?.disconnect()
    container.removeEventListener("click", handleClick)
    container.removeEventListener("scroll", updateOverflow, true)
    codeEnhancements.delete(container)
  }
  container.addEventListener("click", handleClick)
  container.addEventListener("scroll", updateOverflow, true)
  refresh()
  return cleanup
}
