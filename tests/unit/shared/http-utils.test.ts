import { describe, it, expect, vi } from 'vitest';
import { 
  extractBearerToken, 
  isLocalhost, 
  getClientIp, 
  getLocalIp, 
  sendJson, 
  parseBody
} from '../../../shared/http-utils';
import type { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import os from 'os';

describe('http-utils', () => {
  describe('extractBearerToken', () => {
    it('extracts token from valid Bearer header and returns null for invalid or missing ones', () => {
      const validReq = { headers: { authorization: 'Bearer my-token-123' } } as unknown as IncomingMessage;
      expect(extractBearerToken(validReq)).toBe('my-token-123');

      const missingReq = { headers: {} } as unknown as IncomingMessage;
      expect(extractBearerToken(missingReq)).toBeNull();

      const malformedCases = ['Basic user:pass', 'Bearer', 'bearer space'];
      malformedCases.forEach(auth => {
        const req = { headers: { authorization: auth } } as unknown as IncomingMessage;
        expect(extractBearerToken(req)).toBeNull();
      });
    });
  });

  describe('isLocalhost', () => {
    it('identifies localhost addresses and rejects non-localhost addresses', () => {
      const localhostCases = ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'];
      localhostCases.forEach(addr => expect(isLocalhost(addr)).toBe(true));

      const remoteCases = ['192.168.1.1', '8.8.8.8', 'google.com', ''];
      remoteCases.forEach(addr => expect(isLocalhost(addr)).toBe(false));
    });
  });

  describe('getClientIp', () => {
    it('prefers x-forwarded-for header, falls back to socket.remoteAddress, and returns unknown if none found', () => {
      // x-forwarded-for
      const reqForwarded = { headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' } } as unknown as IncomingMessage;
      expect(getClientIp(reqForwarded)).toBe('203.0.113.195');

      // socket fallback
      const reqSocket = { headers: {}, socket: { remoteAddress: '1.2.3.4' } } as unknown as IncomingMessage;
      expect(getClientIp(reqSocket)).toBe('1.2.3.4');

      // unknown
      const reqUnknown = { headers: {} } as unknown as IncomingMessage;
      expect(getClientIp(reqUnknown)).toBe('unknown');
    });
  });

  describe('getLocalIp', () => {
    it('returns a valid IP address from real os module or localhost fallback', () => {
      const ip = getLocalIp();
      const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
      expect(ipv4Regex.test(ip) || ip === 'localhost').toBe(true);
    });

    it('filters network interfaces correctly and handles various edge cases with mocks', () => {
      // Skips virtual and internal IPs
      const mockOsStandard = {
        networkInterfaces: () => ({
          'docker0': [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
          'eth0': [
            { address: '127.0.0.1', family: 'IPv4', internal: true },
            { address: '192.168.1.5', family: 'IPv4', internal: false }
          ]
        })
      } as unknown as typeof os;
      expect(getLocalIp(mockOsStandard)).toBe('192.168.1.5');

      // Uses fallback if only virtual interfaces are available
      const mockOsVirtualOnly = {
        networkInterfaces: () => ({
          'veth123': [{ address: '10.0.0.1', family: 'IPv4', internal: false }]
        })
      } as unknown as typeof os;
      expect(getLocalIp(mockOsVirtualOnly)).toBe('10.0.0.1');

      // Returns localhost if no interfaces found
      const mockOsEmpty = { networkInterfaces: () => ({}) } as unknown as typeof os;
      expect(getLocalIp(mockOsEmpty)).toBe('localhost');
    });
  });

  describe('sendJson', () => {
    it('sends correct JSON response with headers and default status', () => {
      const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
      const data = { success: true };

      // Explicit status 201
      sendJson(res, data, 201);
      expect(res.writeHead).toHaveBeenCalledWith(201, expect.objectContaining({
        'Content-Type': 'application/json'
      }));
      expect(res.end).toHaveBeenCalledWith(JSON.stringify(data));

      // Default status 200
      sendJson(res, {});
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });
  });

  describe('parseBody', () => {
    it('parses valid JSON bodies and handles empty input', async () => {
      // Valid JSON
      const reqValid = new EventEmitter() as any;
      const promiseValid = parseBody(reqValid);
      reqValid.emit('data', Buffer.from('{"foo": "bar"}'));
      reqValid.emit('end');
      expect(await promiseValid).toEqual({ foo: 'bar' });

      // Empty body
      const reqEmpty = new EventEmitter() as any;
      const promiseEmpty = parseBody(reqEmpty);
      reqEmpty.emit('end');
      expect(await promiseEmpty).toEqual({});
    });

    it('rejects for various error conditions: invalid JSON, too large, or stream errors', async () => {
      // Invalid JSON
      const reqInvalid = new EventEmitter() as any;
      const promiseInvalid = parseBody(reqInvalid);
      reqInvalid.emit('data', 'invalid');
      reqInvalid.emit('end');
      await expect(promiseInvalid).rejects.toThrow('Invalid JSON');

      // Too large
      const reqLarge = new EventEmitter() as any;
      reqLarge.destroy = vi.fn();
      const promiseLarge = parseBody(reqLarge);
      reqLarge.emit('data', 'x'.repeat(1024 * 1024 + 1));
      await expect(promiseLarge).rejects.toThrow('Request body too large');
      expect(reqLarge.destroy).toHaveBeenCalled();

      // Stream error
      const reqError = new EventEmitter() as any;
      const promiseError = parseBody(reqError);
      reqError.emit('error', new Error('stream error'));
      await expect(promiseError).rejects.toThrow('stream error');
    });
  });
});
