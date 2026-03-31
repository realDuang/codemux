import { describe, it, expect } from "vitest";
import { createSlug, slugify } from "../../../../electron/main/services/slug";

describe("createSlug", () => {
  it("generates adjective-noun format", () => {
    const slug = createSlug();
    expect(slug).toMatch(/^[a-z]+-[a-z]+$/);
    const [adj, noun] = slug.split("-");
    expect(adj.length).toBeGreaterThan(2);
    expect(noun.length).toBeGreaterThan(2);
  });

  it("generates different slugs across multiple calls", () => {
    const slugs = new Set(Array.from({ length: 50 }, () => createSlug()));
    // With 29*31 = 899 combos, 50 calls should produce at least 10 unique
    expect(slugs.size).toBeGreaterThanOrEqual(10);
  });
});

describe("slugify", () => {
  it("lowercases and replaces non-alphanumeric chars with hyphens", () => {
    expect(slugify("My Feature Branch!")).toBe("my-feature-branch");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  it("handles whitespace", () => {
    expect(slugify("  fix  bug  ")).toBe("fix-bug");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("collapses consecutive separators", () => {
    expect(slugify("a---b___c")).toBe("a-b-c");
  });

  it("preserves numbers", () => {
    expect(slugify("version 2.0")).toBe("version-2-0");
  });
});
