import { onMount } from "solid-js";
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

  onMount(async () => {
    const isValidToken = await Auth.checkDeviceToken();
    if (!isValidToken) {
      logger.debug(`[${pageName}] Device token invalid, redirecting to login`);
      Auth.clearAuth();
      navigate("/login", { replace: true });
    }
  });
}
