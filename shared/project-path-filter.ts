export interface ProjectPathFilter {
  whitelist: string[];
  blacklist: string[];
}

export const MAX_PROJECT_FILTER_PATHS = 200;
const MAX_PROJECT_PATH_LENGTH = 4096;

/** Normalize absolute paths without depending on the client's operating system. */
export function normalizeProjectPath(path: string): string | null {
  if (!path || path.length > MAX_PROJECT_PATH_LENGTH || /\p{Cc}/u.test(path)) return null;
  const normalized = path.replaceAll("\\", "/");
  let prefix: string;
  let remainder: string;
  let windowsPath = false;

  if (/^[a-z]:\//i.test(normalized)) {
    prefix = `${normalized[0].toLowerCase()}:/`;
    remainder = normalized.slice(3);
    windowsPath = true;
  } else if (normalized.startsWith("//") && !normalized.startsWith("///")) {
    const [server, share, ...segments] = normalized.slice(2).split("/").filter(Boolean);
    if (!server || !share || [server, share].some((segment) => segment === "." || segment === ".." || segment === "?")) return null;
    prefix = `//${server}/${share}`;
    remainder = segments.join("/");
    windowsPath = true;
  } else if (normalized.startsWith("/")) {
    prefix = "/";
    remainder = normalized.slice(1);
  } else {
    return null;
  }

  const segments: string[] = [];
  for (const segment of remainder.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const separator = prefix.endsWith("/") || segments.length === 0 ? "" : "/";
  const result = `${prefix}${separator}${segments.join("/")}`;
  return windowsPath ? result.toLowerCase() : result;
}

export function isValidProjectPathFilter(value: unknown): value is ProjectPathFilter {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("whitelist") || !keys.includes("blacklist")) return false;
  const filter = value as Record<string, unknown>;
  for (const paths of [filter.whitelist, filter.blacklist]) {
    if (!Array.isArray(paths) || paths.length > MAX_PROJECT_FILTER_PATHS) return false;
    for (const path of paths) {
      if (typeof path !== "string" || normalizeProjectPath(path) !== path) return false;
    }
  }
  return true;
}

export function readProjectPathFilter(value: unknown): ProjectPathFilter {
  if (isValidProjectPathFilter(value)) {
    return { whitelist: [...value.whitelist], blacklist: [...value.blacklist] };
  }
  return { whitelist: [], blacklist: [] };
}

function matchesProjectPath(path: string, rule: string): boolean {
  const root = normalizeProjectPath(rule);
  if (root === null || (root === "/" && path.startsWith("//"))) return false;
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export function isProjectPathVisible(path: string, filter: ProjectPathFilter): boolean {
  const directory = normalizeProjectPath(path);
  if (directory === null) return filter.whitelist.length === 0;
  if (filter.blacklist.some((rule) => matchesProjectPath(directory, rule))) return false;
  return filter.whitelist.length === 0 || filter.whitelist.some((rule) => matchesProjectPath(directory, rule));
}
