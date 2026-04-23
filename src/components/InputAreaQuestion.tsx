import { createSignal, createMemo, For, Show } from "solid-js";
import type { UnifiedQuestion } from "../types/unified";
import { formatMessage, useI18n } from "../lib/i18n";
import { getQuestionContext } from "./input-area-context";
import styles from "./InputAreaQuestion.module.css";

interface InputAreaQuestionProps {
  question: UnifiedQuestion;
  onRespond: (sessionID: string, questionID: string, answers: string[][]) => void;
  onDismiss: (sessionID: string, questionID: string) => void;
}

/**
 * InputAreaQuestion — Full-width question prompt displayed in the input area.
 *
 * Design: vertical stacked full-width option cards with radio/checkbox indicators,
 * label + description layout, multi-question pagination with progress dots.
 * Inspired by OpenCode's SessionQuestionDock.
 */
export function InputAreaQuestion(props: InputAreaQuestionProps) {
  const { t } = useI18n();

  const totalQuestions = () => props.question.questions.length;
  const isMultiQuestion = () => totalQuestions() > 1;

  // Current page index for multi-question pagination
  const [pageIndex, setPageIndex] = createSignal(0);

  // Selection state per question: selections[i] = array of selected option labels
  const [selections, setSelections] = createSignal<string[][]>(
    props.question.questions.map(() => []),
  );

  // Custom text input per question
  const [customInputs, setCustomInputs] = createSignal<string[]>(
    props.question.questions.map(() => ""),
  );

  // Current question info
  const currentQ = () => props.question.questions[pageIndex()];

  const isMultiSelect = () => currentQ()?.multiple ?? false;

  const toggleOption = (label: string) => {
    const qi = pageIndex();
    setSelections((prev) => {
      const updated = [...prev];
      const current = [...(updated[qi] || [])];

      if (isMultiSelect()) {
        const idx = current.indexOf(label);
        if (idx >= 0) {
          current.splice(idx, 1);
        } else {
          current.push(label);
        }
        updated[qi] = current;
      } else {
        // Single select: toggle or replace
        if (current.length === 1 && current[0] === label) {
          updated[qi] = [];
        } else {
          updated[qi] = [label];
        }
      }
      return updated;
    });
  };

  const setCustomInput = (value: string) => {
    const qi = pageIndex();
    setCustomInputs((prev) => {
      const updated = [...prev];
      updated[qi] = value;
      return updated;
    });
  };

  // Check if any question has at least one answer
  const hasAnyAnswer = () => {
    return props.question.questions.some((_, i) => {
      const selected = selections()[i] || [];
      const custom = customInputs()[i]?.trim();
      return selected.length > 0 || (custom && custom.length > 0);
    });
  };

  // Check if current page has an answer
  const currentHasAnswer = () => {
    const qi = pageIndex();
    const selected = selections()[qi] || [];
    const custom = customInputs()[qi]?.trim();
    return selected.length > 0 || (custom && custom.length > 0);
  };

  const handleSubmit = () => {
    const answers = props.question.questions.map((_, i) => {
      const selected = selections()[i] || [];
      const custom = customInputs()[i]?.trim();
      if (custom) return [...selected, custom];
      return [...selected];
    });
    props.onRespond(props.question.sessionId, props.question.id, answers);
  };

  const handleDismiss = () => {
    props.onDismiss(props.question.sessionId, props.question.id);
  };

  const goNext = () => {
    if (pageIndex() < totalQuestions() - 1) {
      setPageIndex(pageIndex() + 1);
    }
  };

  const goBack = () => {
    if (pageIndex() > 0) {
      setPageIndex(pageIndex() - 1);
    }
  };

  const isLastPage = () => pageIndex() >= totalQuestions() - 1;
  const questionContext = createMemo(() => getQuestionContext(props.question, pageIndex()));
  const questionProgressLabel = createMemo(() => formatMessage(t().question.progress, {
    current: questionContext().current,
    total: questionContext().total,
  }));

  return (
    <div class={styles.root}>
      {/* Header */}
      <div class={styles.header}>
        <span class={styles.headerIcon}>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" />
          </svg>
        </span>
        <span class={styles.headerLabel}>{t().question.waitingAnswer}</span>

        {/* Progress dots for multi-question */}
        <Show when={isMultiQuestion()}>
          <div class={styles.progress}>
            <For each={props.question.questions}>
              {(_, i) => (
                <span
                  class={styles.progressDot}
                  data-active={i() === pageIndex() ? "" : undefined}
                  data-done={i() < pageIndex() ? "" : undefined}
                />
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={questionContext().isMultiQuestion}>
        <div class={styles.meta}>
          <span class={styles.metaBadge}>{questionProgressLabel()}</span>
        </div>
      </Show>

      {/* Current question */}
      <Show when={currentQ()}>
        <div class={styles.questionSection}>
          {/* Badge + question text */}
          <div>
            <span class={styles.questionBadge}>{currentQ().header}</span>
            <span class={styles.questionText}>{currentQ().question}</span>
          </div>

          {/* Hint */}
          <Show when={isMultiSelect()}>
            <div class={styles.questionHint}>
              {t().question.selectMultiple || "Select multiple options"}
            </div>
          </Show>

          {/* Options */}
          <div class={styles.options}>
            <For each={currentQ().options}>
              {(opt) => {
                const isPicked = () => (selections()[pageIndex()] || []).includes(opt.label);
                const type = () => isMultiSelect() ? "checkbox" : "radio";

                return (
                  <button
                    type="button"
                    class={styles.option}
                    data-picked={isPicked() ? "" : undefined}
                    role={type()}
                    aria-checked={isPicked()}
                    onClick={() => toggleOption(opt.label)}
                  >
                    {/* Check indicator */}
                    <span class={styles.optionCheck}>
                      <span
                        class={styles.optionBox}
                        data-type={type()}
                        data-picked={isPicked() ? "" : undefined}
                      >
                        <Show
                          when={type() === "checkbox"}
                          fallback={<span class={styles.radioDot} />}
                        >
                          <Show when={isPicked()}>
                            <svg class={styles.checkIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          </Show>
                        </Show>
                      </span>
                    </span>

                    {/* Label + description */}
                    <span class={styles.optionMain}>
                      <span class={styles.optionLabel}>{opt.label}</span>
                      <Show when={opt.description}>
                        <span class={styles.optionDescription}>{opt.description}</span>
                      </Show>
                    </span>
                  </button>
                );
              }}
            </For>
          </div>

          {/* Custom text input */}
          <Show when={currentQ().custom !== false}>
            <input
              type="text"
              class={styles.customInput}
              placeholder={t().question.customPlaceholder}
              value={customInputs()[pageIndex()] || ""}
              onInput={(e) => setCustomInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.isComposing && hasAnyAnswer()) {
                  e.preventDefault();
                  if (isLastPage()) {
                    handleSubmit();
                  } else {
                    goNext();
                  }
                }
              }}
            />
          </Show>
        </div>
      </Show>

      {/* Actions */}
      <div class={styles.actions}>
        <button type="button" class={styles.btnDismiss} onClick={handleDismiss}>
          {t().question.dismiss}
        </button>

        <Show when={isMultiQuestion() && pageIndex() > 0}>
          <button type="button" class={styles.btnNav} onClick={goBack}>
            {t().question.back || "Back"}
          </button>
        </Show>

        <Show
          when={isLastPage()}
          fallback={
            <button type="button" class={styles.btnNav} onClick={goNext} style={{ "margin-left": "auto" }}>
              {t().question.next || "Next"}
            </button>
          }
        >
          <button
            type="button"
            class={styles.btnSubmit}
            onClick={handleSubmit}
            disabled={!hasAnyAnswer()}
          >
            {t().question.submit}
          </button>
        </Show>
      </div>
    </div>
  );
}
