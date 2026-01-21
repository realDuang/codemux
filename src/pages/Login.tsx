import { createSignal, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Auth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { logger } from "../lib/logger";

export default function Login() {
  const { t } = useI18n();
  const [code, setCode] = createSignal("");
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [checking, setChecking] = createSignal(true);
  const navigate = useNavigate();

  onMount(async () => {
    logger.debug("Login page mounted, checking device token...");

    // Check if we have a valid device token
    const hasValidToken = await Auth.checkDeviceToken();
    logger.debug("Device token valid:", hasValidToken);

    if (hasValidToken) {
      // Already authenticated, redirect to chat
      navigate("/chat", { replace: true });
    } else {
      // Show login form
      setChecking(false);
    }
  });

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    logger.debug("Submitting code");

    try {
      const result = await Auth.loginWithCode(code());
      logger.debug("Auth result:", result);

      if (result.success) {
        navigate("/chat", { replace: true });
      } else {
        setError(result.error || t().login.invalidCode);
      }
    } catch (err) {
      logger.error("Auth error:", err);
      setError(t().login.errorOccurred);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="flex items-center justify-center min-h-screen bg-gray-100 dark:bg-zinc-900">
      <div class="absolute top-4 right-4">
        <LanguageSwitcher />
      </div>

      {/* Loading state while checking device token */}
      <Show when={checking()}>
        <div class="text-center">
          <div class="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
          <p class="text-gray-500 dark:text-gray-400">{t().login.checkingDevice}</p>
        </div>
      </Show>

      {/* Login form */}
      <Show when={!checking()}>
        <div class="w-full max-w-md p-8 bg-white dark:bg-zinc-800 rounded-lg shadow-md">
          <h1 class="text-2xl font-bold text-center mb-6 text-gray-800 dark:text-white">
            {t().login.title}
          </h1>

          <form onSubmit={handleSubmit} class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t().login.accessCode}
              </label>
              <input
                type="text"
                value={code()}
                onInput={(e) => setCode(e.currentTarget.value)}
                placeholder={t().login.placeholder}
                class="w-full px-4 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 focus:outline-none dark:bg-zinc-700 dark:border-zinc-600 dark:text-white"
                maxLength={6}
                disabled={loading()}
                autofocus
              />
            </div>

            <Show when={error()}>
              <div class="text-red-500 text-sm text-center">{error()}</div>
            </Show>

            <button
              type="submit"
              disabled={loading() || code().length !== 6}
              class="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading() ? t().login.verifying : t().login.connect}
            </button>
          </form>

          {/* Info about device token */}
          <p class="text-xs text-gray-500 dark:text-gray-400 text-center mt-4">
            {t().login.rememberDevice}
          </p>
        </div>
      </Show>
    </div>
  );
}
