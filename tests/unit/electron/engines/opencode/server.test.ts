import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStreamErrorHandler, fetchVersion, killOrphanedProcess } from '../../../../../electron/main/engines/opencode/server';
import { openCodeLog } from '../../../../../electron/main/services/logger';
import { execFile } from 'child_process';
import * as net from 'net';

vi.mock('../../../../../electron/main/services/logger', () => ({
  openCodeLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('child_process');
vi.mock('net', () => ({
  Socket: vi.fn().mockImplementation(function() {
    return {
      setTimeout: vi.fn(),
      once: vi.fn(),
      connect: vi.fn(),
      destroy: vi.fn(),
    };
  })
}));

const mockExecFile = vi.mocked(execFile);

describe('opencode/server.ts', () => {
  describe('createStreamErrorHandler', () => {
    it('suppresses EPIPE and logs other errors to provided or default logger', () => {
      const customLog = vi.fn();
      const handlerWithCustom = createStreamErrorHandler('stdout', customLog);
      const handlerWithDefault = createStreamErrorHandler('stderr');

      // EPIPE should be silent
      handlerWithCustom({ code: 'EPIPE' } as any);
      expect(customLog).not.toHaveBeenCalled();

      // Non-EPIPE should call custom logger
      const err = { code: 'ECONNRESET', message: 'fail' } as any;
      handlerWithCustom(err);
      expect(customLog).toHaveBeenCalledWith(expect.stringContaining('stdout'), err);

      // Default logger (openCodeLog.warn)
      handlerWithDefault(err);
      expect(openCodeLog.warn).toHaveBeenCalledWith(expect.stringContaining('stderr'), err);
    });
  });

  describe('fetchVersion', () => {
    it('returns trimmed version string on success, undefined on error or empty output', async () => {
      // Success
      mockExecFile.mockImplementation((file, args, opts, cb) => {
        (cb as any)(null, '  1.2.3  \n', '');
        return {} as any;
      });
      await expect(fetchVersion()).resolves.toBe('1.2.3');

      // Error
      mockExecFile.mockImplementation((file, args, opts, cb) => {
        (cb as any)(new Error('fail'), '', '');
        return {} as any;
      });
      await expect(fetchVersion()).resolves.toBeUndefined();

      // Empty output
      mockExecFile.mockImplementation((file, args, opts, cb) => {
        (cb as any)(null, '  ', '');
        return {} as any;
      });
      await expect(fetchVersion()).resolves.toBeUndefined();
    });
  });

  describe('killOrphanedProcess', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.useFakeTimers();
    });

    it('kills process using platform-specific commands if port is in use', async () => {
      // Mock net.Socket class
      const mockSocket: any = {
        setTimeout: vi.fn(),
        once: vi.fn(function(event, cb) {
          if (event === 'connect') {
            // Simulate connection success in next tick
            setTimeout(cb, 0);
          }
          return this;
        }),
        connect: vi.fn(),
        destroy: vi.fn(),
      };
      
      vi.mocked(net.Socket).mockImplementation(function() { return mockSocket; } as any);

      // Test Non-Windows (fuser)
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockExecFile.mockImplementation((file, args, opts, cb) => {
        (cb as any)(null, '', '');
        return {} as any;
      });

      // Reread IS_WIN from server.ts is not possible as it's a constant evaluated at import time.
      // However, the function killOrphanedProcess uses IS_WIN internally.
      // Since IS_WIN is likely true in this environment (Windows), it skips the linux path.
      
      const killPromise = killOrphanedProcess(4096);
      await vi.runAllTimersAsync();
      await killPromise;

      // Check if it called either fuser or powershell depending on what IS_WIN was at import time
      const isActuallyWin = originalPlatform === 'win32';
      if (isActuallyWin) {
        expect(mockExecFile).toHaveBeenCalledWith('powershell', expect.any(Array), expect.any(Object), expect.any(Function));
      } else {
        expect(mockExecFile).toHaveBeenCalledWith('fuser', expect.any(Array), expect.any(Object), expect.any(Function));
      }

      // Restore platform
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('returns immediately if port is not in use', async () => {
      const mockSocket: any = {
        setTimeout: vi.fn(),
        once: vi.fn(function(event, cb) {
          if (event === 'error') {
            setTimeout(cb, 0);
          }
          return this;
        }),
        connect: vi.fn(),
        destroy: vi.fn(),
      };
      vi.mocked(net.Socket).mockImplementation(function() { return mockSocket; } as any);

      const killPromise = killOrphanedProcess(4096);
      await vi.runAllTimersAsync();
      await killPromise;
      
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });
});

/**
 * createOpencodeServer is skipped due to heavy coupling with spawn/stdio and high complexity.
 * It primarily orchestrates spawn calls and parses stdout for a "listening" line.
 */
