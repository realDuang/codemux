// ============================================================================
// WeChat iLink QR Login Flow
// Standalone helpers for fetching QR codes and polling scan status.
// Used by IPC handlers to drive the renderer-side login modal.
//
// Protocol notes (verified from hello-halo ipc/weixin-ilink.ts):
//   - GET /ilink/bot/get_bot_qrcode?bot_type=3  (no auth)
//     Response: { qrcode, qrcode_img_content (URL) }  — no `ret` field
//   - GET /ilink/bot/get_qrcode_status?qrcode=...  (header iLink-App-ClientVersion: 1)
//     Response: { status, bot_token?, ilink_bot_id?, baseurl?, ilink_user_id? }
//     status: 'wait' | 'scaned' | 'confirmed' | 'expired'
//     ilink_bot_id is required on 'confirmed'.
// ============================================================================

import QRCode from "qrcode";
import {
  ILINK_BASE_URL,
  type GetQrCodeResponse,
  type QrCodeStatusResponse,
} from "./weixin-ilink-types";
import { fetchIlinkJson } from "./weixin-ilink-transport";

export interface QrCodeResult {
  /** Token used as input to pollQrStatus */
  qrcode: string;
  /** URL to the QR image content */
  qrcodeImgContent: string;
  /** Base URL used (echoed for renderer to track) */
  baseUrl: string;
}

export interface QrCodeStatusResult {
  status: "wait" | "scaned" | "confirmed" | "expired";
  /** Present only on `confirmed` */
  botToken?: string;
  /** Present only on `confirmed` (= ilink_bot_id) */
  accountId?: string;
  /** Optional override base URL — server-provided */
  baseUrl?: string;
  /** Who scanned (informational only) */
  userId?: string;
}

/** Fetch a fresh QR code token for the iLink bot login flow. */
export async function getQrCode(baseUrl?: string): Promise<QrCodeResult> {
  const root = baseUrl || ILINK_BASE_URL;
  const url = `${root}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const resp = await fetchIlinkJson<GetQrCodeResponse>("GET", url, {});
  if (!resp.qrcode) {
    throw new Error("iLink API returned no qrcode token");
  }

  // `qrcode_img_content` is NOT an image — it is the WeChat short-link string
  // that the user must scan with their phone (e.g.
  // `https://liteapp.weixin.qq.com/q/...`). Encode it ourselves into a QR
  // code data URL so the renderer can `<img src=...>` it directly.
  let qrcodeImgContent = "";
  if (resp.qrcode_img_content) {
    try {
      qrcodeImgContent = await encodeQrAsDataUrl(resp.qrcode_img_content);
    } catch (err) {
      // Fallback: pass the raw string through. Renderer will fail to render
      // it as an image, surfacing the error path with a retry button.
      qrcodeImgContent = resp.qrcode_img_content;
    }
  }

  return {
    qrcode: resp.qrcode,
    qrcodeImgContent,
    baseUrl: root,
  };
}

/** Encode an arbitrary string into a `data:image/png;base64,...` QR code. */
async function encodeQrAsDataUrl(value: string): Promise<string> {
  return QRCode.toDataURL(value, {
    width: 256,
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
  });
}

/** Poll the scan status for a QR code. Renderer should call this every ~2s. */
export async function pollQrStatus(
  qrcode: string,
  baseUrl?: string,
): Promise<QrCodeStatusResult> {
  if (!qrcode) {
    throw new Error("qrcode parameter is required");
  }
  const root = baseUrl || ILINK_BASE_URL;
  const url = `${root}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const resp = await fetchIlinkJson<QrCodeStatusResponse>("GET", url, {
    "iLink-App-ClientVersion": "1",
  });

  if (resp.status === "confirmed" && !resp.ilink_bot_id) {
    throw new Error("iLink confirmed login but ilink_bot_id is missing");
  }

  return {
    status: resp.status ?? "wait",
    botToken: resp.bot_token,
    accountId: resp.ilink_bot_id,
    baseUrl: resp.baseurl,
    userId: resp.ilink_user_id,
  };
}
