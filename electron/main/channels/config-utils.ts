export function omitUndefinedConfig<T extends object>(updates?: Partial<T>): Partial<T> {
  if (!updates) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

export function mergeDefinedConfig<T extends object>(baseConfig: T, updates?: Partial<T>): T {
  return {
    ...baseConfig,
    ...omitUndefinedConfig(updates),
  };
}

export function didConfigValuesChange<T extends object, K extends keyof T>(
  previousConfig: T,
  nextConfig: T,
  keys: readonly K[],
): boolean {
  return keys.some((key) => previousConfig[key] !== nextConfig[key]);
}
