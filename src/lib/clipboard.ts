/** Call directly from a user gesture so HTTP pages can use the legacy copy path. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const userActivated = navigator.userActivation?.isActive;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // The Clipboard API can be unavailable or denied even on HTTPS.
  }

  if (userActivated === false || typeof document.execCommand !== "function") {
    return false;
  }

  const focusedElement = document.activeElement;
  const focusedInput = focusedElement instanceof HTMLInputElement || focusedElement instanceof HTMLTextAreaElement
    ? focusedElement
    : null;
  const inputSelection = focusedInput && focusedInput.selectionStart !== null && focusedInput.selectionEnd !== null
    ? { start: focusedInput.selectionStart, end: focusedInput.selectionEnd, direction: focusedInput.selectionDirection }
    : null;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : [];
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;font-size:16px;";
  document.body.appendChild(textarea);

  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (focusedElement instanceof HTMLElement) {
      focusedElement.focus({ preventScroll: true });
    }
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
    if (focusedInput && inputSelection) {
      focusedInput.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined);
    }
  }
}
