import { createMemo } from "solid-js";
import spriteUrl from "./file-icons/sprite.svg?url";
import {
  FILE_NAMES,
  FILE_EXTENSIONS,
  FOLDER_NAMES,
  FOLDER_NAMES_EXPANDED,
  DEFAULT_FILE_ICON,
  DEFAULT_FOLDER_ICON,
  DEFAULT_FOLDER_EXPANDED_ICON,
} from "./file-icons/icon-map";

interface FileIconProps {
  name: string;
  type: "file" | "directory";
  expanded?: boolean;
  class?: string;
  size?: number;
  dimmed?: boolean;
}

/** Convert manifest icon name (e.g. "folder-open") to sprite symbol ID (e.g. "FolderOpen") */
function toSpriteId(name: string): string {
  return name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

function resolveIconName(
  name: string,
  type: "file" | "directory",
  expanded?: boolean
): string {
  const lower = name.toLowerCase();

  if (type === "directory") {
    if (expanded) {
      const expandedIcon = FOLDER_NAMES_EXPANDED[lower];
      if (expandedIcon) return toSpriteId(expandedIcon);
    }
    const folderIcon = FOLDER_NAMES[lower];
    if (folderIcon) return toSpriteId(folderIcon);
    return expanded
      ? toSpriteId(DEFAULT_FOLDER_EXPANDED_ICON)
      : toSpriteId(DEFAULT_FOLDER_ICON);
  }

  // Check exact filename match
  const fileNameIcon = FILE_NAMES[lower];
  if (fileNameIcon) return toSpriteId(fileNameIcon);

  // Check multi-dot extensions (e.g. "test.ts", "spec.tsx")
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    const extIcon = FILE_EXTENSIONS[ext];
    if (extIcon) return toSpriteId(extIcon);
  }

  return toSpriteId(DEFAULT_FILE_ICON);
}

export function FileIcon(props: FileIconProps) {
  const iconId = createMemo(() =>
    resolveIconName(props.name, props.type, props.expanded)
  );

  const size = () => props.size ?? 16;

  return (
    <span
      class={`inline-flex items-center justify-center flex-shrink-0 ${props.dimmed ? "opacity-40" : ""} ${props.class ?? ""}`}
      style={{ width: `${size()}px`, height: `${size()}px` }}
    >
      <svg width={size()} height={size()}>
        <use href={`${spriteUrl}#${iconId()}`} />
      </svg>
    </span>
  );
}
