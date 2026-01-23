import { logger } from "./logger";

// ============================================================================
// Types
// ============================================================================

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  browser: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string;
}

interface AuthResponse {
  success: boolean;
  token?: string;
  deviceId?: string;
  device?: DeviceInfo;
  error?: string;
}

interface ValidateResponse {
  valid: boolean;
  deviceId?: string;
  device?: DeviceInfo;
}

interface DevicesResponse {
  devices: DeviceInfo[];
  currentDeviceId: string;
}

// ============================================================================
// Auth Class
// ============================================================================

export class Auth {
  private static TOKEN_KEY = "opencode_device_token";
  private static DEVICE_ID_KEY = "opencode_device_id";

  // -------------------------------------------------------------------------
  // Token Management
  // -------------------------------------------------------------------------

  static saveToken(token: string): void {
    localStorage.setItem(this.TOKEN_KEY, token);
  }

  static getToken(): string | null {
    return localStorage.getItem(this.TOKEN_KEY);
  }

  static saveDeviceId(deviceId: string): void {
    localStorage.setItem(this.DEVICE_ID_KEY, deviceId);
  }

  static getDeviceId(): string | null {
    return localStorage.getItem(this.DEVICE_ID_KEY);
  }

  static clearAuth(): void {
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.DEVICE_ID_KEY);
  }

  static isAuthenticated(): boolean {
    return !!this.getToken();
  }

  static getAuthHeaders(): Record<string, string> {
    const token = this.getToken();
    if (token) {
      return { Authorization: `Bearer ${token}` };
    }
    return {};
  }

  // -------------------------------------------------------------------------
  // Device Info Collection
  // -------------------------------------------------------------------------

  private static parseDeviceName(ua: string): string {
    // iOS devices
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/iPod/.test(ua)) return "iPod";

    // Android devices
    if (/Android/.test(ua)) {
      const match = ua.match(/Android[^;]*;\s*([^)]+)/);
      if (match) {
        const device = match[1].split(" Build")[0].trim();
        if (device.length < 30) return device;
      }
      return "Android Device";
    }

    // Desktop
    if (/Macintosh/.test(ua)) return "Mac";
    if (/Windows/.test(ua)) return "Windows PC";
    if (/Linux/.test(ua)) return "Linux PC";
    if (/CrOS/.test(ua)) return "Chromebook";

    return "Unknown Device";
  }

  private static parsePlatform(ua: string): string {
    if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
    if (/Android/.test(ua)) return "Android";
    if (/Macintosh/.test(ua)) return "macOS";
    if (/Windows/.test(ua)) return "Windows";
    if (/Linux/.test(ua)) return "Linux";
    if (/CrOS/.test(ua)) return "ChromeOS";
    return "Unknown";
  }

  private static parseBrowser(ua: string): string {
    // Order matters - check more specific ones first
    if (/Edg\//.test(ua)) return "Edge";
    if (/OPR\/|Opera/.test(ua)) return "Opera";
    if (/Firefox\//.test(ua)) return "Firefox";
    if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) return "Chrome";
    if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "Safari";
    if (/MSIE|Trident\//.test(ua)) return "IE";
    return "Unknown";
  }

  static collectDeviceInfo(): { name: string; platform: string; browser: string } {
    const ua = navigator.userAgent;
    return {
      name: this.parseDeviceName(ua),
      platform: this.parsePlatform(ua),
      browser: this.parseBrowser(ua),
    };
  }

  // -------------------------------------------------------------------------
  // API Methods
  // -------------------------------------------------------------------------

  /**
   * Check if current device token is still valid
   * Returns true if valid, false if not (should show login)
   */
  static async checkDeviceToken(): Promise<boolean> {
    const token = this.getToken();
    if (!token) return false;

    try {
      const response = await fetch("/api/auth/validate", {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const data: ValidateResponse = await response.json();
        if (data.valid && data.deviceId) {
          // Update local device ID if needed
          this.saveDeviceId(data.deviceId);
          return true;
        }
      }

      // Token invalid - clear it
      this.clearAuth();
      return false;
    } catch (err) {
      logger.error("Token validation error:", err);
      // Network error - assume token might still be valid
      // Let the user proceed, they'll get 401 on actual API calls
      return true;
    }
  }

  /**
   * Login with 6-digit access code
   */
  static async loginWithCode(code: string): Promise<{ success: boolean; error?: string }> {
    try {
      const deviceInfo = this.collectDeviceInfo();

      const response = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          device: deviceInfo,
        }),
      });

      const data: AuthResponse = await response.json();

      if (response.ok && data.success && data.token && data.deviceId) {
        this.saveToken(data.token);
        this.saveDeviceId(data.deviceId);
        return { success: true };
      } else {
        return { success: false, error: data.error || "Login failed" };
      }
    } catch (err) {
      logger.error("Login error:", err);
      return { success: false, error: "Network error" };
    }
  }

  /**
   * Logout current device
   */
  static async logout(): Promise<void> {
    const token = this.getToken();
    if (token) {
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        logger.error("Logout error:", err);
      }
    }
    this.clearAuth();
  }

  /**
   * Get list of all authorized devices
   */
  static async getDevices(): Promise<{ devices: DeviceInfo[]; currentDeviceId: string } | null> {
    const token = this.getToken();
    if (!token) return null;

    try {
      const response = await fetch("/api/devices", {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        return await response.json() as DevicesResponse;
      }
      return null;
    } catch (err) {
      logger.error("Get devices error:", err);
      return null;
    }
  }

  /**
   * Revoke access for a specific device
   */
  static async revokeDevice(deviceId: string): Promise<boolean> {
    const token = this.getToken();
    if (!token) return false;

    try {
      const response = await fetch(`/api/devices/${deviceId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      return response.ok;
    } catch (err) {
      logger.error("Revoke device error:", err);
      return false;
    }
  }

  /**
   * Rename a device
   */
  static async renameDevice(deviceId: string, name: string): Promise<boolean> {
    const token = this.getToken();
    if (!token) return false;

    try {
      const response = await fetch(`/api/devices/${deviceId}/rename`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name }),
      });

      return response.ok;
    } catch (err) {
      logger.error("Rename device error:", err);
      return false;
    }
  }

  /**
   * Revoke all devices except current
   */
  static async revokeOtherDevices(): Promise<{ success: boolean; revokedCount?: number }> {
    const token = this.getToken();
    if (!token) return { success: false };

    try {
      const response = await fetch("/api/devices/revoke-others", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const data = await response.json();
        return { success: true, revokedCount: data.revokedCount };
      }
      return { success: false };
    } catch (err) {
      logger.error("Revoke other devices error:", err);
      return { success: false };
    }
  }

  /**
   * Get access code (for display in Remote Access page)
   */
  static async getAccessCode(): Promise<string | null> {
    const token = this.getToken();
    if (!token) return null;

    try {
      const response = await fetch("/api/auth/code", {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const data = await response.json();
        return data.code || null;
      }
      return null;
    } catch (err) {
      logger.error("Get access code error:", err);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Local Access Methods
  // -------------------------------------------------------------------------

  /**
   * Check if current request is from localhost
   */
  static async isLocalAccess(): Promise<boolean> {
    try {
      const response = await fetch("/api/system/is-local");
      if (response.ok) {
        const data = await response.json();
        return data.isLocal === true;
      }
      return false;
    } catch (err) {
      logger.error("Check local access error:", err);
      return false;
    }
  }

  /**
   * Auto-authenticate for local access (localhost only)
   */
  static async localAuth(): Promise<{ success: boolean; error?: string }> {
    try {
      const deviceInfo = this.collectDeviceInfo();

      const response = await fetch("/api/auth/local-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device: deviceInfo }),
      });

      const data: AuthResponse = await response.json();

      if (response.ok && data.success && data.token && data.deviceId) {
        this.saveToken(data.token);
        this.saveDeviceId(data.deviceId);
        return { success: true };
      } else {
        return { success: false, error: data.error || "Local auth failed" };
      }
    } catch (err) {
      logger.error("Local auth error:", err);
      return { success: false, error: "Network error" };
    }
  }
}
