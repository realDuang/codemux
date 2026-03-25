// ============================================================================
// WeCom Callback Crypto
// Handles WeCom callback message encryption/decryption.
// WeCom uses AES-256-CBC with PKCS#7 padding (block size 32).
// EncodingAESKey (43 chars Base64) → 32-byte AES key, IV = first 16 bytes.
// Message format: random(16) + msg_len(4, big-endian) + msg + corp_id
// ============================================================================

import crypto from "crypto";

export class WeComCrypto {
  private aesKey: Buffer;
  private iv: Buffer;

  constructor(
    private token: string,
    encodingAESKey: string,
    private corpId: string,
  ) {
    // EncodingAESKey is 43 chars Base64; append "=" to make valid Base64 → 32 bytes
    this.aesKey = Buffer.from(encodingAESKey + "=", "base64");
    this.iv = this.aesKey.subarray(0, 16);
  }

  /**
   * Verify callback URL (GET request).
   * Validates the signature, decrypts echostr, and returns the plaintext.
   * Returns null if verification fails.
   */
  verifyUrl(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    echostr: string,
  ): string | null {
    const expectedSignature = this.generateSignature(timestamp, nonce, echostr);
    if (expectedSignature !== msgSignature) {
      return null;
    }
    return this.decrypt(echostr);
  }

  /** Debug version of decrypt that returns error details instead of null */
  debugDecrypt(encrypted: string): { result: string | null; error?: string } {
    try {
      const encryptedBuf = Buffer.from(encrypted, "base64");
      const decipher = crypto.createDecipheriv("aes-256-cbc", this.aesKey, this.iv);
      decipher.setAutoPadding(false);
      const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);

      const padLen = decrypted[decrypted.length - 1];
      if (padLen < 1 || padLen > 32) {
        return { result: null, error: `Invalid PKCS#7 pad length: ${padLen}` };
      }
      const unpadded = decrypted.subarray(0, decrypted.length - padLen);

      const msgLen = unpadded.readUInt32BE(16);
      const msg = unpadded.subarray(20, 20 + msgLen).toString("utf-8");
      const receivedCorpId = unpadded.subarray(20 + msgLen).toString("utf-8");

      if (receivedCorpId !== this.corpId) {
        return { result: null, error: `CorpId mismatch: received="${receivedCorpId}", expected="${this.corpId}"` };
      }

      return { result: msg };
    } catch (err: any) {
      return { result: null, error: `Decrypt exception: ${err.message}` };
    }
  }

  /**
   * Decrypt an incoming callback message (POST request).
   * Validates signature, then decrypts the encrypted XML content.
   * Returns the decrypted XML message string, or null on failure.
   */
  decryptMessage(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    encryptedContent: string,
  ): string | null {
    const expectedSignature = this.generateSignature(timestamp, nonce, encryptedContent);
    if (expectedSignature !== msgSignature) {
      return null;
    }
    return this.decrypt(encryptedContent);
  }

  /**
   * Encrypt a reply message into XML format for WeCom callback response.
   * Returns the encrypted XML string.
   */
  encryptReply(replyMsg: string, timestamp: string, nonce: string): string {
    const encrypted = this.encrypt(replyMsg);
    const signature = this.generateSignature(timestamp, nonce, encrypted);
    return [
      "<xml>",
      `<Encrypt><![CDATA[${encrypted}]]></Encrypt>`,
      `<MsgSignature><![CDATA[${signature}]]></MsgSignature>`,
      `<TimeStamp>${timestamp}</TimeStamp>`,
      `<Nonce><![CDATA[${nonce}]]></Nonce>`,
      "</xml>",
    ].join("\n");
  }

  /**
   * Generate SHA1 signature: sort([token, timestamp, nonce, encrypt]) → SHA1
   */
  generateSignature(timestamp: string, nonce: string, encrypt: string): string {
    const parts = [this.token, timestamp, nonce, encrypt].sort();
    return crypto.createHash("sha1").update(parts.join("")).digest("hex");
  }

  /**
   * AES-256-CBC decrypt with PKCS#7 padding (block size 32).
   * Decrypted format: random(16) + msg_len(4, big-endian uint32) + msg + corp_id
   */
  private decrypt(encrypted: string): string | null {
    try {
      const encryptedBuf = Buffer.from(encrypted, "base64");
      const decipher = crypto.createDecipheriv("aes-256-cbc", this.aesKey, this.iv);
      decipher.setAutoPadding(false);
      const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);

      // Remove PKCS#7 padding (block size 32)
      const padLen = decrypted[decrypted.length - 1];
      if (padLen < 1 || padLen > 32) return null;
      const unpadded = decrypted.subarray(0, decrypted.length - padLen);

      // Parse: skip 16 random bytes, read 4-byte message length (big-endian)
      const msgLen = unpadded.readUInt32BE(16);
      const msg = unpadded.subarray(20, 20 + msgLen).toString("utf-8");
      const receivedCorpId = unpadded.subarray(20 + msgLen).toString("utf-8");

      // Verify corpId
      if (receivedCorpId !== this.corpId) return null;

      return msg;
    } catch {
      return null;
    }
  }

  /**
   * AES-256-CBC encrypt with PKCS#7 padding (block size 32).
   * Plaintext format: random(16) + msg_len(4, big-endian uint32) + msg + corp_id
   */
  private encrypt(message: string): string {
    const randomBytes = crypto.randomBytes(16);
    const msgBuf = Buffer.from(message, "utf-8");
    const corpIdBuf = Buffer.from(this.corpId, "utf-8");

    // 4-byte big-endian message length
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(msgBuf.length, 0);

    const plaintext = Buffer.concat([randomBytes, lenBuf, msgBuf, corpIdBuf]);

    // PKCS#7 padding to block size 32
    const blockSize = 32;
    const padLen = blockSize - (plaintext.length % blockSize);
    const padding = Buffer.alloc(padLen, padLen);
    const padded = Buffer.concat([plaintext, padding]);

    const cipher = crypto.createCipheriv("aes-256-cbc", this.aesKey, this.iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

    return encrypted.toString("base64");
  }
}
