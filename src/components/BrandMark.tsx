import { publicAssetUrl } from "../lib/public-assets";

/** Titlebar brand: glowing logo tile + "CodeMux" wordmark with gradient accent. */
export function BrandMark() {
  return (
    <div class="flex items-center gap-2 electron-no-drag flex-shrink-0 titlebar-brand pr-1">
      <span class="cm-brand-mark"><img src={publicAssetUrl("logo.png")} alt="CodeMux" class="w-5 h-5 rounded-[7px]" /></span>
      <span class="hidden sm:inline text-[13px] font-semibold tracking-tight text-gray-900 dark:text-gray-50 select-none">
        Code<span class="cm-gradient-text">Mux</span>
      </span>
    </div>
  );
}
