import { useNavigate } from "@solidjs/router";
import { SkillSettingsSection } from "../components/SkillSettingsSection";
import { useI18n } from "../lib/i18n";
import { useAuthGuard } from "../lib/useAuthGuard";

export default function Skills() {
  const { t } = useI18n();
  const navigate = useNavigate();

  useAuthGuard("Skills");

  return (
    <div class="flex flex-col h-screen bg-gray-50 dark:bg-slate-950 font-sans text-gray-900 dark:text-gray-100">
      <div
        class="w-full flex-shrink-0 flex items-center px-2 border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-950 electron-drag-region electron-titlebar-pad-left electron-titlebar-pad-right"
        style={{ height: "var(--electron-title-bar-height, 40px)", "min-height": "var(--electron-title-bar-height, 40px)" }}
      >
        <div class="flex items-center gap-1.5 electron-no-drag flex-shrink-0 titlebar-brand">
          <img src={`${import.meta.env.BASE_URL}assets/logo.png`} alt="CodeMux" class="w-5 h-5 rounded" />
          <span class="hidden sm:inline text-[11px] font-semibold tracking-wide text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-slate-800 px-2 py-0.5 rounded-md border border-gray-200 dark:border-slate-700 select-none">CodeMux</span>
        </div>
        <div class="flex items-center gap-2 electron-no-drag flex-shrink-0">
          <button
            onClick={() => navigate("/chat")}
            class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-slate-700 rounded transition-colors"
            title={t().settings.back}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <h1 class="text-[13px] font-medium text-gray-600 dark:text-gray-400">{t().skill.title}</h1>
        </div>
        <div class="flex-1" />
      </div>

      <main class="flex-1 overflow-y-auto px-3 sm:px-6 pb-8 pt-6">
        <div class="max-w-5xl mx-auto">
          <SkillSettingsSection />
        </div>
      </main>
    </div>
  );
}
