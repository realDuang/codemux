import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron-log BEFORE importing
vi.mock('electron-log/main', () => {
  const mockLog: any = {
    transports: {
      file: { 
        resolvePathFn: null, 
        maxSize: 0, 
        level: 'warn', 
        format: '', 
        getFile: vi.fn(() => ({ path: '/tmp/test.log' })) 
      },
      console: { level: 'info', format: '' },
    },
    errorHandler: { startCatching: vi.fn() },
    eventLogger: { startLogging: vi.fn() },
    scope: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  };
  return { default: mockLog };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) => name === 'logs' ? '/tmp/logs' : '/tmp/userData'),
  },
}));

vi.mock('fs');

import log from 'electron-log/main';
import fs from 'fs';
import {
  feishuLog,
  getDefaultEngineFromSettings,
  getFeishuChannelLog,
  getFileLogLevel,
  getLogFilePath,
  larkLog,
  loadSettings,
  saveSettings,
  setFileLogLevel,
} from '../../../../electron/main/services/logger';

describe('logger.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadSettings', () => {
    it('returns parsed JSON or empty object on error', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{"a": 1}');
      expect(loadSettings()).toEqual({ a: 1 });

      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error(); });
      expect(loadSettings()).toEqual({});

      vi.mocked(fs.readFileSync).mockReturnValue('invalid json');
      expect(loadSettings()).toEqual({});
    });
  });

  describe('saveSettings', () => {
    it('deep merges objects, replaces arrays, and writes atomically', () => {
      // Mock existing settings: { a: { x: 1 }, b: [1] }
      vi.mocked(fs.readFileSync).mockReturnValue('{"a": {"x": 1}, "b": [1]}');
      vi.mocked(fs.existsSync).mockReturnValue(true);

      saveSettings({ a: { y: 2 }, b: [2], c: 3 });

      // Check merged settings: a: {x: 1, y: 2}, b: [2], c: 3
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);

      expect(savedData.a).toEqual({ x: 1, y: 2 });
      expect(savedData.b).toEqual([2]);
      expect(savedData.c).toBe(3);

      // Verify atomic write: write to .tmp, then rename
      expect(writeCall[0]).toMatch(/\.tmp$/);
      expect(fs.renameSync).toHaveBeenCalled();
      
      // Verify directory creation if missing
      vi.mocked(fs.existsSync).mockReturnValue(false);
      saveSettings({ x: 1 });
      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });
  });

  describe('setFileLogLevel', () => {
    it('updates transport level and persists if valid, otherwise ignores', () => {
      setFileLogLevel('debug');
      expect(log.transports.file.level).toBe('debug');
      
      // Should not call saveSettings for invalid level
      vi.mocked(fs.writeFileSync).mockClear();
      setFileLogLevel('invalid-level');
      expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
    });
  });

  describe('getFileLogLevel / getLogFilePath', () => {
    it('returns correct transport values', () => {
      log.transports.file.level = 'info';
      expect(getFileLogLevel()).toBe('info');
      
      expect(getLogFilePath()).toBe('/tmp/test.log');
    });
  });

  describe('getFeishuChannelLog', () => {
    it('returns the scoped logger matching the selected platform', () => {
      expect(getFeishuChannelLog('feishu')).toBe(feishuLog);
      expect(getFeishuChannelLog('lark')).toBe(larkLog);
    });
  });

  describe('getDefaultEngineFromSettings', () => {
    it('returns defaultEngine when explicitly set', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ defaultEngine: 'claude' }));
      expect(getDefaultEngineFromSettings()).toBe('claude');
    });

    it('falls back to "opencode" when defaultEngine is missing', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
      expect(getDefaultEngineFromSettings()).toBe('opencode');
    });

    it('falls back to "opencode" when defaultEngine is empty', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ defaultEngine: '' }));
      expect(getDefaultEngineFromSettings()).toBe('opencode');
    });
  });
});
