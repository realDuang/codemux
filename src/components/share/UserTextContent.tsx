import { For, Show } from "solid-js";
import type { TextPart } from "../../types/unified";
import { ContentMarkdown } from "./content-markdown";
import { ContentText } from "./content-text";

interface Props {
  part: TextPart;
  expand?: boolean;
  workingDirectory?: string;
}

export function UserTextContent(props: Props) {
  return (
    <Show when={props.part.questionReplies?.length ? props.part.questionReplies : undefined}
      fallback={<ContentText text={props.part.displayText ?? props.part.text} expand={props.expand} plain />}>
      {replies => (
        <div class="flex min-w-0 flex-col gap-3" data-component="question-replies">
          <For each={replies()}>{reply => (
            <div class="min-w-0">
              <p class="mb-1 truncate text-sm text-[var(--cm-text-muted)]" title={reply.summary ?? reply.question}>{reply.summary ?? reply.question}</p>
              <ContentMarkdown text={reply.answer} expand workingDirectory={props.workingDirectory} />
            </div>
          )}</For>
        </div>
      )}
    </Show>
  );
}
