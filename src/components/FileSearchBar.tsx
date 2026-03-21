import { createSignal, createEffect, on, Show, onMount, onCleanup } from "solid-js";
import { useI18n } from "../lib/i18n";

interface FileSearchBarProps {
  content: string;
  onClose: () => void;
}

export function FileSearchBar(props: FileSearchBarProps) {
  const { t } = useI18n();
  const [query, setQuery] = createSignal("");
  const [matches, setMatches] = createSignal<number[]>([]);
  const [currentMatch, setCurrentMatch] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  onMount(() => inputRef?.focus());

  createEffect(on(query, (q) => {
    if (!q || q.length < 2) {
      setMatches([]);
      setCurrentMatch(0);
      return;
    }
    const content = props.content.toLowerCase();
    const search = q.toLowerCase();
    const positions: number[] = [];
    let idx = content.indexOf(search);
    while (idx !== -1) {
      positions.push(idx);
      idx = content.indexOf(search, idx + 1);
    }
    setMatches(positions);
    setCurrentMatch(positions.length > 0 ? 1 : 0);
  }));

  const goNext = () => {
    if (matches().length === 0) return;
    setCurrentMatch((c) => c >= matches().length ? 1 : c + 1);
  };

  const goPrev = () => {
    if (matches().length === 0) return;
    setCurrentMatch((c) => c <= 1 ? matches().length : c - 1);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      props.onClose();
    } else if (e.key === "Enter") {
      if (e.shiftKey) goPrev();
      else goNext();
    }
  };

  return (
    <div class="flex items-center gap-2 px-3 py-1.5 bg-gray-50 dark:bg-zinc-800 border-b border-gray-200 dark:border-zinc-700">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        class="text-gray-400 flex-shrink-0">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder={t().fileExplorer.searchInFile}
        class="flex-1 text-[13px] bg-transparent outline-none text-gray-900 dark:text-gray-100 placeholder:text-gray-400"
      />
      <Show when={query().length >= 2}>
        <span class="text-[11px] text-gray-400 tabular-nums flex-shrink-0">
          {matches().length > 0
            ? `${currentMatch()} / ${matches().length}`
            : t().fileExplorer.noResults}
        </span>
      </Show>
      <button onClick={goPrev} class="p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded" title={t().fileExplorer.searchPrev}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 15-6-6-6 6"/></svg>
      </button>
      <button onClick={goNext} class="p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded" title={t().fileExplorer.searchNext}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <button onClick={props.onClose} class="p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded" title={t().fileExplorer.searchClose}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
  );
}
