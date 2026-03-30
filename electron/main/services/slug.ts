/**
 * Slug generator for human-readable random names.
 * Used for worktree naming (e.g. "brave-cabin", "cosmic-rocket").
 */

const ADJECTIVES = [
  "brave",
  "calm",
  "clever",
  "cosmic",
  "crisp",
  "curious",
  "eager",
  "gentle",
  "glowing",
  "happy",
  "hidden",
  "jolly",
  "kind",
  "lucky",
  "mighty",
  "misty",
  "neon",
  "nimble",
  "playful",
  "proud",
  "quick",
  "quiet",
  "shiny",
  "silent",
  "stellar",
  "sunny",
  "swift",
  "tidy",
  "witty",
] as const;

const NOUNS = [
  "cabin",
  "cactus",
  "canyon",
  "circuit",
  "comet",
  "eagle",
  "engine",
  "falcon",
  "forest",
  "garden",
  "harbor",
  "island",
  "knight",
  "lagoon",
  "meadow",
  "moon",
  "mountain",
  "nebula",
  "orchid",
  "otter",
  "panda",
  "pixel",
  "planet",
  "river",
  "rocket",
  "sailor",
  "squid",
  "star",
  "tiger",
  "wizard",
  "wolf",
] as const;

export function createSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}
