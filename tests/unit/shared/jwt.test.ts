import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateJWT, verifyJWT } from '../../../shared/jwt';

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
    it('generates a valid JWT string and encodes the payload correctly', () => {
      const token = generateJWT(payload, secret);
      const parts = token.split('.');
      
      // Check structure
      expect(parts).toHaveLength(3);
      parts.forEach(part => {
        expect(part).toMatch(/^[A-Za-z0-9\-_]+$/);
      });

      // Check payload encoding
      const decoded = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded).toHaveProperty('iat');
      expect(decoded).toHaveProperty('exp');
    });

    it('applies default or custom expiration times correctly', () => {
      const now = 1000000;
      vi.setSystemTime(now * 1000);
      
      // Default expiration (365 days)
      const tokenDefault = generateJWT(payload, secret);
      const decodedDefault = JSON.parse(Buffer.from(tokenDefault.split('.')[1], 'base64').toString());
      expect(decodedDefault.exp).toBe(now + 365 * 24 * 60 * 60);
      expect(decodedDefault.iat).toBe(now);

      // Custom expiration (7 days)
      const days = 7;
      const tokenCustom = generateJWT(payload, secret, days);
      const decodedCustom = JSON.parse(Buffer.from(tokenCustom.split('.')[1], 'base64').toString());
      expect(decodedCustom.exp).toBe(now + days * 24 * 60 * 60);
    });

    it('produces different tokens for different payloads but consistent tokens for identical inputs', () => {
      const now = 1000000;
      vi.setSystemTime(now * 1000);

      const token1 = generateJWT({ id: '1' }, secret);
      const token2 = generateJWT({ id: '2' }, secret);
      const token3 = generateJWT({ id: '1' }, secret);

      expect(token1).not.toBe(token2);
      expect(token1).toBe(token3);
    });
  });

  describe('verifyJWT', () => {
    it('returns payload for valid token and correct secret', () => {
      const token = generateJWT(payload, secret);
      const result = verifyJWT(token, secret);
      expect(result.valid).toBe(true);
      expect(result.payload?.deviceId).toBe(payload.deviceId);
    });

    it.each([
      { name: 'wrong secret', secret: 'wrong-secret', setup: (t: string) => t },
      { name: 'expired token', secret: secret, setup: (t: string) => {
          vi.advanceTimersByTime(366 * 24 * 60 * 60 * 1000);
          return t;
        } 
      },
      { name: 'tampered payload', secret: secret, setup: (t: string) => {
          const parts = t.split('.');
          const tampered = parts[1].substring(0, 5) + (parts[1][5] === 'A' ? 'B' : 'A') + parts[1].substring(6);
          return `${parts[0]}.${tampered}.${parts[2]}`;
        }
      },
      { name: 'tampered signature', secret: secret, setup: (t: string) => {
          const parts = t.split('.');
          const tampered = parts[2].substring(0, 5) + (parts[2][5] === 'X' ? 'Y' : 'X') + parts[2].substring(6);
          return `${parts[0]}.${parts[1]}.${tampered}`;
        }
      }
    ])('rejects invalid tokens: $name', ({ secret: verifySecret, setup }) => {
      const originalToken = generateJWT(payload, secret);
      const token = setup(originalToken);
      const result = verifyJWT(token, verifySecret);
      expect(result.valid).toBe(false);
    });

    it('rejects structurally invalid or malformed tokens', () => {
      // Wrong number of segments
      expect(verifyJWT('not-a-token', secret).valid).toBe(false);
      expect(verifyJWT('part1.part2', secret).valid).toBe(false);
      expect(verifyJWT('part1.part2.part3.part4', secret).valid).toBe(false);

      // Signature length mismatch
      const token = generateJWT(payload, secret);
      const parts = token.split('.');
      expect(verifyJWT(`${parts[0]}.${parts[1]}.short`, secret).valid).toBe(false);
      expect(verifyJWT(`${parts[0]}.${parts[1]}.${parts[2]}extra`, secret).valid).toBe(false);

      // Non-JSON payload
      const headerB64 = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString('base64url');
      const badPayloadB64 = Buffer.from('not-json').toString('base64url');
      const malformedToken = `${headerB64}.${badPayloadB64}.somesig`;
      expect(verifyJWT(malformedToken, secret).valid).toBe(false);
    });
  });
});
