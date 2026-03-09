import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import styles from "./TextShimmer.module.css";

interface TextShimmerProps {
  text: string;
  active?: boolean;
  class?: string;
}

/**
 * TextShimmer — a text element with a gradient sweep animation.
 *
 * A light band sweeps left-to-right across the text using
 * `background-clip: text`, giving a shimmering "thinking" effect.
 *
 * The sweep speed scales with text length so the perceived velocity
 * stays uniform regardless of string length.
 */
export function TextShimmer(props: TextShimmerProps) {
  const text = createMemo(() => props.text ?? "");
  const active = createMemo(() => props.active ?? true);

  // Delayed deactivation: keep animation running for 220ms after active→false
  // so it fades out gracefully instead of freezing mid-sweep.
  const [running, setRunning] = createSignal(active());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const SWAP_MS = 220;

  createEffect(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (active()) {
      setRunning(true);
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      setRunning(false);
    }, SWAP_MS);
  });

  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer);
  });

  // Duration: longer text → proportionally longer animation so the sweep
  // moves at a consistent visual speed.
  // Formula: duration = len × (shimmerSize - 1) / velocity
  const len = createMemo(() => Math.max(text().length, 1));
  const shimmerSize = createMemo(() => Math.max(300, Math.round(200 + 1400 / len())));

  const VELOCITY = 0.01375; // ch per ms — uniform perceived sweep speed
  const duration = createMemo(() => {
    const s = shimmerSize() / 100;
    return Math.max(1000, Math.min(2500, Math.round((len() * (s - 1)) / VELOCITY)));
  });

  return (
    <span
      class={`${styles.root} ${props.class ?? ""}`}
      data-active={active() ? "true" : "false"}
      aria-label={text()}
      style={{
        "--shimmer-swap": `${SWAP_MS}ms`,
        "--shimmer-size": `${shimmerSize()}%`,
        "--shimmer-duration": `${duration()}ms`,
      }}
    >
      {/* Base layer: always visible, inherits parent color */}
      <span class={styles.charBase} aria-hidden="true">
        {text()}
      </span>
      {/* Shimmer layer: gradient-clipped overlay, animated when running */}
      <span
        class={styles.charShimmer}
        data-run={running() ? "true" : "false"}
        aria-hidden="true"
      >
        {text()}
      </span>
    </span>
  );
}
