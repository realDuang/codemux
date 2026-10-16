import { describe, expect, it } from "vitest";
import {
  isProjectPathVisible,
  isValidProjectPathFilter,
  MAX_PROJECT_FILTER_PATHS,
  normalizeProjectPath,
  readProjectPathFilter,
} from "../../../shared/project-path-filter";

describe("project path filters", () => {
  describe("normalizeProjectPath", () => {
    it.each([
      ["/Users/Dev/repo/./src/../", "/Users/Dev/repo"],
      ["///repo//src", "/repo/src"],
      ["/../../repo", "/repo"],
      ["/", "/"],
      ["C:\\Users\\Dev\\repo\\..\\App\\", "c:/users/dev/app"],
      ["C:///", "c:/"],
      ["\\\\NAS\\Share\\repo\\..\\App", "//nas/share/app"],
      ["//NAS/Share/../../repo", "//nas/share/repo"],
      ["//NAS/Share/", "//nas/share"],
      ["/folder with spaces/project", "/folder with spaces/project"],
    ])("normalizes %j to %j", (path, expected) => {
      expect(normalizeProjectPath(path)).toBe(expected);
    });

    it.each(["", "repo", "~/repo", "C:repo", "C:", "//nas", "//?/C:/repo", "/repo\u0000/private", "/repo\t/private", "/repo\u0085/private"])("rejects invalid path %j", (path) => {
      expect(normalizeProjectPath(path)).toBeNull();
    });

    it("bounds path length before normalization", () => {
      expect(normalizeProjectPath(`/${"a".repeat(4095)}`)).toHaveLength(4096);
      expect(normalizeProjectPath(`/${"a".repeat(4096)}`)).toBeNull();
    });
  });

  describe("isValidProjectPathFilter", () => {
    it("accepts bounded canonical absolute paths on different host platforms", () => {
      expect(isValidProjectPathFilter({ whitelist: ["/Users/Dev/repo", "c:/projects", "//nas/share"], blacklist: ["/Users/Dev/repo/private"] })).toBe(true);
      expect(isValidProjectPathFilter({ whitelist: [], blacklist: [] })).toBe(true);
      expect(isValidProjectPathFilter({ whitelist: Array(MAX_PROJECT_FILTER_PATHS).fill("/repo"), blacklist: [] })).toBe(true);
    });

    it.each([
      null,
      [],
      { whitelist: [] },
      { whitelist: [], blacklist: [], enabled: true },
      { whitelist: "", blacklist: [] },
      { whitelist: ["/repo/"], blacklist: [] },
      { whitelist: ["C:/Projects"], blacklist: [] },
      { whitelist: [], blacklist: ["relative"] },
      { whitelist: [], blacklist: [null] },
      { whitelist: Array(1), blacklist: [] },
      { whitelist: Array(MAX_PROJECT_FILTER_PATHS + 1).fill("/repo"), blacklist: [] },
    ])("rejects malformed filter %j", (filter) => {
      expect(isValidProjectPathFilter(filter)).toBe(false);
    });
  });

  describe("readProjectPathFilter", () => {
    it("returns an independent copy and recovers invalid saved values", () => {
      const saved = { whitelist: ["/repo"], blacklist: ["/repo/private"] };
      const filter = readProjectPathFilter(saved);
      filter.whitelist.push("/other");
      filter.blacklist.length = 0;
      expect(saved).toEqual({ whitelist: ["/repo"], blacklist: ["/repo/private"] });
      const fallback = readProjectPathFilter({ whitelist: ["relative"], blacklist: [] });
      fallback.whitelist.push("/other");
      expect(readProjectPathFilter(undefined)).toEqual({ whitelist: [], blacklist: [] });
    });
  });

  describe("isProjectPathVisible", () => {
    it("matches descendants by folder boundary and gives blacklist rules precedence", () => {
      const filter = { whitelist: ["/repo"], blacklist: ["/repo/private"] };
      expect(isProjectPathVisible("/repo", filter)).toBe(true);
      expect(isProjectPathVisible("/repo/public/src", filter)).toBe(true);
      expect(isProjectPathVisible("/repository", filter)).toBe(false);
      expect(isProjectPathVisible("/repo/private", filter)).toBe(false);
      expect(isProjectPathVisible("/repo/private/src", filter)).toBe(false);
      expect(isProjectPathVisible("/repo/private-copy", filter)).toBe(true);
      expect(isProjectPathVisible("/repo/public/../private", filter)).toBe(false);
    });

    it("uses Windows case rules while preserving POSIX case and filesystem roots", () => {
      expect(isProjectPathVisible("C:\\PROJECTS\\APP", { whitelist: ["c:/projects"], blacklist: [] })).toBe(true);
      expect(isProjectPathVisible("\\\\NAS\\Share\\App", { whitelist: ["//nas/share"], blacklist: [] })).toBe(true);
      expect(isProjectPathVisible("//nas/share-copy/app", { whitelist: ["//nas/share"], blacklist: [] })).toBe(false);
      expect(isProjectPathVisible("/Repo/app", { whitelist: ["/repo"], blacklist: [] })).toBe(false);
      expect(isProjectPathVisible("/repo", { whitelist: ["/"], blacklist: [] })).toBe(true);
      expect(isProjectPathVisible("//nas/share", { whitelist: ["/"], blacklist: [] })).toBe(false);
      expect(isProjectPathVisible("c:/projects", { whitelist: ["c:/"], blacklist: [] })).toBe(true);
    });

    it("allows unrestricted and unknown paths only when the whitelist is empty", () => {
      const filter = { whitelist: [], blacklist: ["/private"] };
      expect(isProjectPathVisible("/other", filter)).toBe(true);
      expect(isProjectPathVisible("", filter)).toBe(true);
      expect(isProjectPathVisible("/private/src", filter)).toBe(false);
      expect(isProjectPathVisible("", { whitelist: ["/repo"], blacklist: [] })).toBe(false);
    });
  });
});
