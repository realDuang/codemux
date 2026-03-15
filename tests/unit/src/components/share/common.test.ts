import { describe, it, expect } from "vitest";
import { formatTokenCount, formatCost } from "../../../../../src/components/share/common";

describe("formatTokenCount", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1.0K"],
    [1500, "1.5K"],
    [12345, "12.3K"],
    [999999, "1.0M"],
    [1000000, "1.0M"],
    [1234567, "1.2M"],
  ] as const)("formats %d as %s", (input, expected) => {
    expect(formatTokenCount(input)).toBe(expected);
  });
});

describe("formatCost", () => {
  it.each([
    [0, "$0.0000"],
    [0.0001, "$0.0001"],
    [0.0182, "$0.0182"],
    [0.5, "$0.5000"],
    [1.2345, "$1.2345"],
    [12.1, "$12.1000"],
  ] as const)("formats %d as %s", (input, expected) => {
    expect(formatCost(input)).toBe(expected);
  });
});
