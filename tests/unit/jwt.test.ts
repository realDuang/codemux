import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateJWT, verifyJWT } from '../../shared/jwt';

describe('JWT Implementation', () => {
  const secret = 'test-secret';
  const payload = { deviceId: 'test-device' };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('generateJWT', () => {
    it('generates a valid JWT string (3 dot-separated base64url segments)', () => {
      const token = generateJWT(payload, secret);
      const parts = token.split('.');
      expect(parts).toHaveLength(3);
      
      // Verify base64url characters only (A-Z, a-z, 0-9, -, _)
      parts.forEach(part => {
        expect(part).toMatch(/^[A-Za-z0-9\-_]+$/);
      });
    });

    it('encodes the payload correctly', () => {
      const token = generateJWT(payload, secret);
      const payloadPart = token.split('.')[1];
      const decoded = JSON.parse(Buffer.from(payloadPart, 'base64').toString());
      
      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded).toHaveProperty('iat');
      expect(decoded).toHaveProperty('exp');
    });

    it('applies default expiration (365 days)', () => {
      const now = 1000000;
      vi.setSystemTime(now * 1000);
      
      const token = generateJWT(payload, secret);
      const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      
      const expectedExp = now + 365 * 24 * 60 * 60;
      expect(decoded.exp).toBe(expectedExp);
      expect(decoded.iat).toBe(now);
    });

    it('works with custom expiration', () => {
      const now = 1000000;
      vi.setSystemTime(now * 1000);
      const days = 7;
      
      const token = generateJWT(payload, secret, days);
      const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      
      const expectedExp = now + days * 24 * 60 * 60;
      expect(decoded.exp).toBe(expectedExp);
    });

    it('produces different tokens for different payloads', () => {
      const token1 = generateJWT({ id: '1' }, secret);
      const token2 = generateJWT({ id: '2' }, secret);
      expect(token1).not.toBe(token2);
    });

    it('produces consistent structure for same payload and secret', () => {
      const now = 1000000;
      vi.setSystemTime(now * 1000);
      
      const token1 = generateJWT(payload, secret);
      const token2 = generateJWT(payload, secret);
      expect(token1).toBe(token2);
    });
  });

  describe('verifyJWT', () => {
    it('returns payload for valid token and correct secret', () => {
      const token = generateJWT(payload, secret);
      const result = verifyJWT(token, secret);
      
      expect(result.valid).toBe(true);
      expect(result.payload?.deviceId).toBe(payload.deviceId);
    });

    it('returns invalid for wrong secret', () => {
      const token = generateJWT(payload, secret);
      const result = verifyJWT(token, 'wrong-secret');
      
      expect(result.valid).toBe(false);
      expect(result.payload).toBeUndefined();
    });

    it('returns invalid for expired token', () => {
      const now = 1000000;
      vi.setSystemTime(now * 1000);
      const token = generateJWT(payload, secret, 1); // 1 day
      
      // Advance time by 2 days
      vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000);
      
      const result = verifyJWT(token, secret);
      expect(result.valid).toBe(false);
    });

    it('returns invalid for tampered payload (signature mismatch)', () => {
      const token = generateJWT(payload, secret);
      const parts = token.split('.');
      
      // Change payload: base64url of {"deviceId":"tampered","iat":...,"exp":...}
      // Simplest way is to replace a character in the middle segment
      const tamperedPayload = parts[1].substring(0, 5) + (parts[1][5] === 'A' ? 'B' : 'A') + parts[1].substring(6);
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
      
      const result = verifyJWT(tamperedToken, secret);
      expect(result.valid).toBe(false);
    });

    it('returns invalid for tampered signature', () => {
      const token = generateJWT(payload, secret);
      const parts = token.split('.');
      
      // Tamper signature segment
      const tamperedSig = parts[2].substring(0, 5) + (parts[2][5] === 'X' ? 'Y' : 'X') + parts[2].substring(6);
      const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSig}`;
      
      const result = verifyJWT(tamperedToken, secret);
      expect(result.valid).toBe(false);
    });

    it('returns invalid for malformed token (wrong number of segments)', () => {
      expect(verifyJWT('not-a-token', secret).valid).toBe(false);
      expect(verifyJWT('part1.part2', secret).valid).toBe(false);
      expect(verifyJWT('part1.part2.part3.part4', secret).valid).toBe(false);
    });

    it('handles signature length mismatch (timingSafeEqual safety)', () => {
      const token = generateJWT(payload, secret);
      const parts = token.split('.');
      
      // Shorter signature
      const shortSigToken = `${parts[0]}.${parts[1]}.short`;
      expect(verifyJWT(shortSigToken, secret).valid).toBe(false);
      
      // Longer signature
      const longSigToken = `${parts[0]}.${parts[1]}.${parts[2]}extra`;
      expect(verifyJWT(longSigToken, secret).valid).toBe(false);
    });

    it('returns invalid for non-JSON payload', () => {
      const headerB64 = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString('base64url');
      const badPayloadB64 = Buffer.from('not-json').toString('base64url');
      const sig = 'somesig';
      const token = `${headerB64}.${badPayloadB64}.${sig}`;
      
      expect(verifyJWT(token, secret).valid).toBe(false);
    });
  });
});
