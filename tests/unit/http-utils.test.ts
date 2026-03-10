import { describe, it, expect, vi } from 'vitest';
import { 
  extractBearerToken, 
  isLocalhost, 
  getClientIp, 
  getLocalIp, 
  sendJson, 
  parseBody
} from '../../shared/http-utils';
import type { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import os from 'os';

describe('http-utils', () => {
  describe('extractBearerToken', () => {
    it('extracts token from valid Bearer header', () => {
      const req = { headers: { authorization: 'Bearer my-token-123' } } as unknown as IncomingMessage;
      expect(extractBearerToken(req)).toBe('my-token-123');
    });

    it('returns null for missing Authorization header', () => {
      const req = { headers: {} } as unknown as IncomingMessage;
      expect(extractBearerToken(req)).toBeNull();
    });

    it('returns null for malformed Bearer header', () => {
      const req1 = { headers: { authorization: 'Basic user:pass' } } as unknown as IncomingMessage;
      const req2 = { headers: { authorization: 'Bearer' } } as unknown as IncomingMessage;
      const req3 = { headers: { authorization: 'bearer space' } } as unknown as IncomingMessage;
      
      expect(extractBearerToken(req1)).toBeNull();
      expect(extractBearerToken(req2)).toBeNull();
      expect(extractBearerToken(req3)).toBeNull();
    });
  });

  describe('isLocalhost', () => {
    it('identifies localhost addresses correctly', () => {
      expect(isLocalhost('127.0.0.1')).toBe(true);
      expect(isLocalhost('::1')).toBe(true);
      expect(isLocalhost('localhost')).toBe(true);
      expect(isLocalhost('::ffff:127.0.0.1')).toBe(true);
    });

    it('returns false for non-localhost addresses', () => {
      expect(isLocalhost('192.168.1.1')).toBe(false);
      expect(isLocalhost('8.8.8.8')).toBe(false);
      expect(isLocalhost('google.com')).toBe(false);
      expect(isLocalhost('')).toBe(false);
    });
  });

  describe('getClientIp', () => {
    it('prefers x-forwarded-for header', () => {
      const req = { 
        headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18, 150.172.238.178' } 
      } as unknown as IncomingMessage;
      expect(getClientIp(req)).toBe('203.0.113.195');
    });

    it('falls back to socket.remoteAddress', () => {
      const req = { 
        headers: {},
        socket: { remoteAddress: '1.2.3.4' }
      } as unknown as IncomingMessage;
      expect(getClientIp(req)).toBe('1.2.3.4');
    });

    it('returns unknown if no IP is found', () => {
      const req = { headers: {} } as unknown as IncomingMessage;
      expect(getClientIp(req)).toBe('unknown');
    });
  });

  describe('getLocalIp', () => {
    it('returns a valid IP address from real os module', () => {
      const ip = getLocalIp();
      const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
      expect(ipv4Regex.test(ip) || ip === 'localhost').toBe(true);
    });

    it('skips virtual interfaces and internal IPs', () => {
      const mockOs = {
        networkInterfaces: () => ({
          'docker0': [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
          'eth0': [
            { address: '127.0.0.1', family: 'IPv4', internal: true },
            { address: 'fe80::1', family: 'IPv6', internal: false },
            { address: '192.168.1.5', family: 'IPv4', internal: false }
          ]
        })
      } as unknown as typeof os;

      expect(getLocalIp(mockOs)).toBe('192.168.1.5');
    });

    it('uses fallback if only virtual interfaces are available', () => {
      const mockOs = {
        networkInterfaces: () => ({
          'veth123': [{ address: '10.0.0.1', family: 'IPv4', internal: false }]
        })
      } as unknown as typeof os;

      expect(getLocalIp(mockOs)).toBe('10.0.0.1');
    });

    it('returns localhost if no interfaces found', () => {
      const mockOs = {
        networkInterfaces: () => ({})
      } as unknown as typeof os;

      expect(getLocalIp(mockOs)).toBe('localhost');
    });
  });

  describe('sendJson', () => {
    it('sends correct JSON response with headers', () => {
      const res = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as unknown as ServerResponse;

      const data = { success: true };
      sendJson(res, data, 201);

      expect(res.writeHead).toHaveBeenCalledWith(201, expect.objectContaining({
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }));
      expect(res.end).toHaveBeenCalledWith(JSON.stringify(data));
    });

    it('uses default status 200', () => {
      const res = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as unknown as ServerResponse;

      sendJson(res, {});
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });
  });

  describe('parseBody', () => {
    it('parses valid JSON body', async () => {
      const req = new EventEmitter() as any;
      const promise = parseBody(req);

      req.emit('data', Buffer.from('{"foo":'));
      req.emit('data', Buffer.from('"bar"}'));
      req.emit('end');

      const result = await promise;
      expect(result).toEqual({ foo: 'bar' });
    });

    it('returns empty object for empty body', async () => {
      const req = new EventEmitter() as any;
      const promise = parseBody(req);

      req.emit('end');

      const result = await promise;
      expect(result).toEqual({});
    });

    it('rejects on invalid JSON', async () => {
      const req = new EventEmitter() as any;
      const promise = parseBody(req);

      req.emit('data', 'invalid');
      req.emit('end');

      await expect(promise).rejects.toThrow('Invalid JSON');
    });

    it('rejects and destroys request if body is too large', async () => {
      const req = new EventEmitter() as any;
      req.destroy = vi.fn();
      const promise = parseBody(req);

      const largeChunk = 'x'.repeat(1024 * 1024 + 1);
      req.emit('data', largeChunk);

      await expect(promise).rejects.toThrow('Request body too large');
      expect(req.destroy).toHaveBeenCalled();
    });

    it('rejects on stream error', async () => {
      const req = new EventEmitter() as any;
      const promise = parseBody(req);

      req.emit('error', new Error('stream error'));

      await expect(promise).rejects.toThrow('stream error');
    });
  });
});
