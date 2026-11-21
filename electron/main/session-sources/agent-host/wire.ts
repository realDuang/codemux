// The SDK publishes ambient const enums, which isolatedModules cannot import as values.
// Retain its complete wire shapes while accepting their JSON string discriminants.
export type Wire<T> = T extends string ? `${T}` : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;
export const SESSION_FLAGS = { error: 2, active: 8, waiting: 24, archived: 64 } as const;
