import { createSignal, createEffect, on, Show, onMount, onCleanup } from "solid-js";
import { useI18n } from "../lib/i18n";

interface FileSearchBarProps {
  content: string;
  scrollContainer: HTMLDivElement | undefined;
  onClose: () => void;
}

export function FileSearchBar(props: FileSearchBarProps) {
  const { t } = useI18n();
  const [query, setQuery] = createSignal("");
  const [matchCount, setMatchCount] = createSignal(0);
  const [currentIndex, setCurrentIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;
  let highlightElements: HTMLElement[] = [];

  onMount(() => inputRef?.focus());

  onCleanup(() => clearHighlights());

  function clearHighlights() {
    for (const el of highlightElements) {
      const parent = el.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(el.textContent || ""), el);
        parent.normalize();
      }
    }
    highlightElements = [];
  }

  function highlightMatches(searchText: string) {
    clearHighlights();

    const container = props.scrollContainer;
    if (!container || !searchText || searchText.length < 2) {
      setMatchCount(0);
      setCurrentIndex(0);
      return;
    }

    const searchLower = searchText.toLowerCase();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];

    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (node.textContent && node.textContent.toLowerCase().includes(searchLower)) {
        textNodes.push(node);
      }
    }

    let count = 0;
    for (const textNode of textNodes) {
      const text = textNode.textContent || "";
      const lowerText = text.toLowerCase();
      const parts: (string | { match: string; index: number })[] = [];
      let lastEnd = 0;
      let idx = lowerText.indexOf(searchLower);

      while (idx !== -1) {
        if (idx > lastEnd) {
          parts.push(text.slice(lastEnd, idx));
        }
        parts.push({ match: text.slice(idx, idx + searchText.length), index: count });
        count++;
        lastEnd = idx + searchText.length;
        idx = lowerText.indexOf(searchLower, lastEnd);
      }

      if (parts.length === 0) continue;
      if (lastEnd < text.length) {
        parts.push(text.slice(lastEnd));
      }

      const parent = textNode.parentNode;
      if (!parent) continue;

      const fragment = document.createDocumentFragment();
      for (const part of parts) {
        if (typeof part === "string") {
          fragment.appendChild(document.createTextNode(part));
        } else {
          const mark = document.createElement("mark");
          mark.className = "file-search-highlight";
          mark.dataset.matchIndex = String(part.index);
          mark.textContent = part.match;
          fragment.appendChild(mark);
          highlightElements.push(mark);
        }
      }
      parent.replaceChild(fragment, textNode);
    }

    setMatchCount(count);
    if (count > 0) {
      setCurrentIndex(1);
      scrollToMatch(0);
    } else {
      setCurrentIndex(0);
    }
  }

  function scrollToMatch(index: number) {
    for (const el of highlightElements) {
      el.className = "file-search-highlight";
    }
    if (index >= 0 && index < highlightElements.length) {
      const target = highlightElements[index];
      target.className = "file-search-highlight-current";
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  const goNext = () => {
    const count = matchCount();
    if (count === 0) return;
    const next = currentIndex() >= count ? 1 : currentIndex() + 1;
    setCurrentIndex(next);
    scrollToMatch(next - 1);
  };

  const goPrev = () => {
    const count = matchCount();
    if (count === 0) return;
    const prev = currentIndex() <= 1 ? count : currentIndex() - 1;
    setCurrentIndex(prev);
    scrollToMatch(prev - 1);
  };

  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(on(query, (q) => {
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => highlightMatches(q), 200);
  }));

  onCleanup(() => clearTimeout(highlightTimer));

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      props.onClose();
    } else if (e.key === "Enter") {
      if (e.shiftKey) goPrev();
      else goNext();
    }
  };

  return (
    <div class="flex items-center gap-2 px-3 py-1.5 bg-gray-50 dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700">
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
          {matchCount() > 0
            ? `${currentIndex()} / ${matchCount()}`
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
