/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Log level: 'debug' | 'info' | 'warn' | 'error' | 'none' */
  readonly VITE_LOG_LEVEL?: "debug" | "info" | "warn" | "error" | "none";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
