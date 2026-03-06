// =============================================================================
// Shared ID Generation Utility
// =============================================================================

import { randomBytes } from "crypto";

let _lastTs = 0;
let _counter = 0;

/**
 * Generate a time-sortable unique ID with a given prefix.
 *
 * Format: `{prefix}_{hex-timestamp}{hex-counter}{random-hex}`
 *
 * Properties:
 * - Monotonically increasing within the same millisecond (counter)
 * - Globally unique (random suffix)
 * - Lexicographically sortable by creation time
 *
 * Examples: "conv_018f4a2b3c001a0b1c2d3e4f", "cs_018f4a2b3c001a0b1c2d3e4f"
 */
export function timeId(prefix: string): string {
  const now = Date.now();
  if (now === _lastTs) {
    _counter++;
  } else {
    _lastTs = now;
    _counter = 0;
  }
  const timePart = now.toString(16).padStart(12, "0");
  const counterPart = (_counter & 0xffff).toString(16).padStart(4, "0");
  const rand = randomBytes(5).toString("hex");
  return `${prefix}_${timePart}${counterPart}${rand}`;
}
