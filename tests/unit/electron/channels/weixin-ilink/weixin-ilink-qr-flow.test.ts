import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, qrCodeMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  qrCodeMock: { toDataURL: vi.fn() },
}));

vi.mock("../../../../../electron/main/channels/weixin-ilink/weixin-ilink-transport", () => ({
  fetchIlinkJson: fetchMock,
}));

vi.mock("qrcode", () => ({
  default: qrCodeMock,
  toDataURL: qrCodeMock.toDataURL,
}));

import {
  getQrCode,
  pollQrStatus,
} from "../../../../../electron/main/channels/weixin-ilink/weixin-ilink-qr-flow";
import { ILINK_BASE_URL } from "../../../../../electron/main/channels/weixin-ilink/weixin-ilink-types";

describe("weixin-ilink qr-flow", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    qrCodeMock.toDataURL.mockReset();
  });

  describe("getQrCode", () => {
    it("throws when API returns no qrcode token", async () => {
      fetchMock.mockResolvedValueOnce({});
      await expect(getQrCode()).rejects.toThrow(/no qrcode token/);
    });

    it("encodes qrcode_img_content as data URL via QRCode.toDataURL on success", async () => {
      fetchMock.mockResolvedValueOnce({
        qrcode: "tok-1",
        qrcode_img_content: "https://wx.qq.com/q/abc",
      });
      qrCodeMock.toDataURL.mockResolvedValueOnce("data:image/png;base64,XYZ");

      const res = await getQrCode();

      expect(res.qrcode).toBe("tok-1");
      expect(res.qrcodeImgContent).toBe("data:image/png;base64,XYZ");
      expect(res.baseUrl).toBe(ILINK_BASE_URL);
      expect(qrCodeMock.toDataURL).toHaveBeenCalledWith(
        "https://wx.qq.com/q/abc",
        expect.objectContaining({ width: 256 }),
      );
    });

    it("falls back to raw image content string if QR encoding throws", async () => {
      fetchMock.mockResolvedValueOnce({
        qrcode: "tok-2",
        qrcode_img_content: "https://wx.qq.com/q/zzz",
      });
      qrCodeMock.toDataURL.mockRejectedValueOnce(new Error("encode failed"));

      const res = await getQrCode();

      expect(res.qrcodeImgContent).toBe("https://wx.qq.com/q/zzz");
    });

    it("uses custom baseUrl when provided", async () => {
      fetchMock.mockResolvedValueOnce({ qrcode: "tk", qrcode_img_content: "" });
      const res = await getQrCode("https://custom.example.com");
      expect(res.baseUrl).toBe("https://custom.example.com");
      expect(fetchMock).toHaveBeenCalledWith(
        "GET",
        expect.stringContaining("https://custom.example.com/ilink/bot/get_bot_qrcode"),
        expect.any(Object),
      );
    });

    it("returns empty qrcodeImgContent when API returns none", async () => {
      fetchMock.mockResolvedValueOnce({ qrcode: "tk", qrcode_img_content: "" });
      const res = await getQrCode();
      expect(res.qrcodeImgContent).toBe("");
      expect(qrCodeMock.toDataURL).not.toHaveBeenCalled();
    });
  });

  describe("pollQrStatus", () => {
    it("rejects when qrcode parameter is empty", async () => {
      await expect(pollQrStatus("")).rejects.toThrow(/qrcode parameter is required/);
    });

    it("returns wait status as default when API omits status", async () => {
      fetchMock.mockResolvedValueOnce({});
      const res = await pollQrStatus("tok");
      expect(res.status).toBe("wait");
      expect(res.botToken).toBeUndefined();
    });

    it("maps API fields to camelCase result on confirmed", async () => {
      fetchMock.mockResolvedValueOnce({
        status: "confirmed",
        bot_token: "tk-x",
        ilink_bot_id: "bot-x",
        baseurl: "https://override.example.com",
        ilink_user_id: "user-x",
      });
      const res = await pollQrStatus("tok");
      expect(res).toEqual({
        status: "confirmed",
        botToken: "tk-x",
        accountId: "bot-x",
        baseUrl: "https://override.example.com",
        userId: "user-x",
      });
    });

    it("throws on confirmed without ilink_bot_id", async () => {
      fetchMock.mockResolvedValueOnce({ status: "confirmed", bot_token: "tk" });
      await expect(pollQrStatus("tok")).rejects.toThrow(/ilink_bot_id is missing/);
    });

    it("URL-encodes the qrcode token", async () => {
      fetchMock.mockResolvedValueOnce({ status: "wait" });
      await pollQrStatus("tok with space&", "https://api.example.com");
      const calledUrl = fetchMock.mock.calls[0][1] as string;
      expect(calledUrl).toContain("qrcode=tok%20with%20space%26");
    });
  });
});
