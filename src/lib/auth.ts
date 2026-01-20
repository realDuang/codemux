import { logger } from "./logger";

export class Auth {
  private static TOKEN_KEY = "opencode_remote_auth";

  // 验证验证码
  static async verify(code: string): Promise<boolean> {
    try {
      const response = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      if (response.ok) {
        const { token } = await response.json();
        this.saveToken(token);
        return true;
      }
      return false;
    } catch (err) {
      logger.error("Auth verification failed:", err);
      return false;
    }
  }

  static saveToken(token: string) {
    localStorage.setItem(this.TOKEN_KEY, token);
  }

  static getToken(): string | null {
    return localStorage.getItem(this.TOKEN_KEY);
  }

  static logout() {
    localStorage.removeItem(this.TOKEN_KEY);
  }

  static isAuthenticated(): boolean {
    return !!this.getToken();
  }
}
