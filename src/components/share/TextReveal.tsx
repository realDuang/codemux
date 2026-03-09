import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import styles from "./TextReveal.module.css";

interface TextRevealProps {
  text: string;
  class?: string;
  /** Vertical travel distance in px for entering/leaving text. Default 20. */
  travel?: number;
  /** Transition duration in ms. Default 300. */
  duration?: number;
  /** Gradient edge softness as percentage (0 = hard wipe, 17 = soft). Default 17. */
  edge?: number;
  /** Only grow width, never shrink. Prevents jitter. Default true. */
  growOnly?: boolean;
  /** Truncate text with overflow clip. Default false. */
  truncate?: boolean;
}

/**
 * TextReveal — animated text transitions with mask-position wipe.
 *
 * When the `text` prop changes, the old text slides upward and fades out
 * while the new text rises in from below, using CSS mask gradients for
 * soft edge reveals. Width transitions use spring-like cubic-bezier.
 *
 * Inspired by OpenCode's TextReveal component.
 */
export function TextReveal(props: TextRevealProps) {
  const [cur, setCur] = createSignal(props.text);
  const [old, setOld] = createSignal<string | undefined>();
  const [width, setWidth] = createSignal("auto");
  const [ready, setReady] = createSignal(false);
  const [swapping, setSwapping] = createSignal(false);

  let inRef: HTMLSpanElement | undefined;
  let outRef: HTMLSpanElement | undefined;
  let rootRef: HTMLSpanElement | undefined;
  let frame: number | undefined;

  const win = () => inRef?.scrollWidth ?? 0;
  const wout = () => outRef?.scrollWidth ?? 0;

  const growOnly = () => props.growOnly ?? true;

  const widen = (next: number) => {
    if (next <= 0) return;
    if (growOnly()) {
      const prev = Number.parseFloat(width());
      if (Number.isFinite(prev) && next <= prev) return;
    }
    setWidth(`${next}px`);
  };

  // Track text changes and trigger swap animation
  createEffect(
    on(
      () => props.text,
      (next, prev) => {
        if (next === prev) return;

        setSwapping(true);
        setOld(prev);
        setCur(next);

        if (typeof requestAnimationFrame !== "function") {
          widen(Math.max(win(), wout()));
          rootRef?.offsetHeight; // force reflow
          setSwapping(false);
          return;
        }

        if (frame !== undefined && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(frame);
        }

        frame = requestAnimationFrame(() => {
          widen(Math.max(win(), wout()));
          rootRef?.offsetHeight; // force reflow
          setSwapping(false);
          frame = undefined;
        });
      },
    ),
  );

  // Initial width measurement
  onMount(() => {
    widen(win());
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;

    if (typeof requestAnimationFrame !== "function") {
      setReady(true);
      return;
    }

    if (!fonts) {
      requestAnimationFrame(() => setReady(true));
      return;
    }

    fonts.ready.finally(() => {
      widen(win());
      requestAnimationFrame(() => setReady(true));
    });
  });

  onCleanup(() => {
    if (frame !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frame);
    }
  });

  const travel = () => props.travel ?? 20;
  const duration = () => props.duration ?? 300;
  const edge = () => props.edge ?? 17;

  return (
    <span
      ref={rootRef}
      class={`${styles.root} ${props.class ?? ""}`}
      data-ready={ready() ? "true" : "false"}
      data-swapping={swapping() ? "true" : "false"}
      data-truncate={props.truncate ? "true" : "false"}
      aria-label={props.text ?? ""}
      style={{
        "--text-reveal-duration": `${duration()}ms`,
        "--text-reveal-edge": `${edge()}%`,
        "--text-reveal-travel": `${travel()}px`,
      }}
    >
      <span
        class={styles.track}
        style={{ width: props.truncate ? "100%" : width() }}
      >
        <span class={styles.entering} ref={inRef}>
          {cur() ?? "\u00A0"}
        </span>
        <span class={styles.leaving} ref={outRef}>
          {old() ?? "\u00A0"}
        </span>
      </span>
    </span>
  );
}
