import {
  createContext,
  useContext,
  createSignal,
  createMemo,
  type ParentProps,
  type Accessor,
} from "solid-js";
import { en, type LocaleDict } from "../locales/en";
import { zh } from "../locales/zh";

// Supported locales
export type LocaleCode = "en" | "zh";

// Dictionary for all locales
const dictionaries: Record<LocaleCode, LocaleDict> = {
  en,
  zh,
};

// Locale display names
export const localeNames: Record<LocaleCode, string> = {
  en: "English",
  zh: "简体中文",
};

// Get saved locale from localStorage or use English as default
function getSavedLocale(): LocaleCode {
  const saved = localStorage.getItem("locale") as LocaleCode | null;
  if (saved && dictionaries[saved]) {
    return saved;
  }
  // Default to English instead of browser language
  return "en";
}

// Save locale to localStorage
function saveLocale(locale: LocaleCode): void {
  localStorage.setItem("locale", locale);
}

// Create locale context type
interface LocaleContextType {
  locale: Accessor<LocaleCode>;
  setLocale: (locale: LocaleCode) => void;
  t: Accessor<LocaleDict>;
}

// Create context
const LocaleContext = createContext<LocaleContextType>();

// Provider component
export function I18nProvider(props: ParentProps) {
  const [locale, setLocaleSignal] = createSignal<LocaleCode>(getSavedLocale());

  const setLocale = (newLocale: LocaleCode) => {
    setLocaleSignal(newLocale);
    saveLocale(newLocale);
  };

  // Create reactive dictionary
  const t = createMemo(() => dictionaries[locale()]);

  const contextValue: LocaleContextType = {
    locale,
    setLocale,
    t,
  };

  return (
    <LocaleContext.Provider value={contextValue}>
      {props.children}
    </LocaleContext.Provider>
  );
}

// Hook to use i18n
export function useI18n(): LocaleContextType {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return context;
}

// Helper function to replace placeholders in strings
// Example: formatMessage("Hello {name}", { name: "World" }) => "Hello World"
export function formatMessage(
  template: string,
  values?: Record<string, string | number>
): string {
  if (!values) return template;
  return template.replace(
    /\{(\w+)\}/g,
    (_, key) => String(values[key] ?? `{${key}}`)
  );
}
