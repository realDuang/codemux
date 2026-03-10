// =============================================================================
// Shared types for DeviceStore across all environments
// (scripts, electron, vite)
// =============================================================================

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  browser: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string;
  /** Whether this device is the local host (localhost access) */
  isHost?: boolean;
}

/**
 * Pending access request from a remote device.
 * Lifecycle: pending -> approved/denied -> (expires after REQUEST_EXPIRY_MS if no action)
 */
export interface PendingRequest {
  /** Unique request ID */
  id: string;
  /** Device fingerprint info */
  device: {
    name: string;
    platform: string;
    browser: string;
  };
  /** Client IP address */
  ip: string;
  /** Request status */
  status: "pending" | "approved" | "denied" | "expired";
  /** Timestamp when request was created */
  createdAt: number;
  /** Timestamp when request was resolved (approved/denied) */
  resolvedAt?: number;
  /** If approved, the generated device ID */
  deviceId?: string;
  /** If approved, the generated token */
  token?: string;
}

export interface DeviceStoreData {
  devices: Record<string, DeviceInfo>;
  pendingRequests: Record<string, PendingRequest>;
  revokedTokens: string[];
  jwtSecret: string;
}
