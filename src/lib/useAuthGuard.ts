import { onMount, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Auth } from "./auth";
import { logger } from "./logger";

/**
 * Hook to verify device token on page mount.
 * Redirects to login if token is invalid or revoked.
 *
 * @param pageName - Name of the page for logging purposes
 */
export function useAuthGuard(pageName: string): void {
  const navigate = useNavigate();
  let disposed = false;
  onCleanup(() => { disposed = true; });

  onMount(async () => {
    const isValidToken = await Auth.checkDeviceToken();
    if (disposed) {
      logger.debug(`[${pageName}] Component disposed during token check, skipping redirect`);
      return;
    }
    if (!isValidToken) {
      logger.debug(`[${pageName}] Device token invalid, redirecting to entry`);
      Auth.clearAuth();
      navigate("/", { replace: true });
    }
  });
}
