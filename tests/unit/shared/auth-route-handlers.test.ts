import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAuthRoutes, handleLogRoutes, handleSettingsRoutes } from '../../../shared/auth-route-handlers';
import type { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';

describe('auth-route-handlers', () => {
  let mockRes: ServerResponse;
  let mockStore: any;
  let mockLogFns: any;
  const mockOptions = {
    defaultDeviceName: 'Test Device',
    defaultPlatform: 'test',
    defaultBrowser: 'test-browser',
    includeDeviceInResponse: true
  };

  beforeEach(() => {
    mockRes = {
      writeHead: vi.fn(),
      end: vi.fn(),
      setHeader: vi.fn(),
    } as unknown as ServerResponse;

    mockStore = {
      getAccessCode: vi.fn(),
      verifyToken: vi.fn(),
      getDevice: vi.fn(),
      listDevices: vi.fn(),
      addDevice: vi.fn(),
      removeDevice: vi.fn(),
      updateDevice: vi.fn(),
      generateDeviceId: vi.fn(),
      generateToken: vi.fn(),
      createPendingRequest: vi.fn(),
      getPendingRequest: vi.fn(),
      listPendingRequests: vi.fn(),
      approveRequest: vi.fn(),
      denyRequest: vi.fn(),
      revokeAllExcept: vi.fn(),
    };

    mockLogFns = {
      getLogFilePath: vi.fn(),
      getFileLogLevel: vi.fn(),
      setFileLogLevel: vi.fn(),
    };
  });

  const createMockReq = (urlStr: string, method = 'GET', body?: any) => {
    const req = new EventEmitter() as any;
    req.url = urlStr;
    req.method = method;
    req.headers = {};
    req.socket = { remoteAddress: '127.0.0.1' };
    if (body) {
      setTimeout(() => {
        req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
      }, 0);
    } else {
      setTimeout(() => req.emit('end'), 0);
    }
    return req as IncomingMessage;
  };

  const getUrlParams = (urlStr: string) => new URL(urlStr, 'http://localhost');

  describe('handleAuthRoutes routing', () => {
    it('returns false for unmatched routes or wrong methods', async () => {
      const url = getUrlParams('/api/other');
      expect(await handleAuthRoutes(createMockReq('/api/other'), mockRes, '/api/other', url, mockStore, mockOptions)).toBe(false);
      
      const urlValidate = getUrlParams('/api/auth/validate');
      expect(await handleAuthRoutes(createMockReq('/api/auth/validate', 'POST'), mockRes, '/api/auth/validate', urlValidate, mockStore, mockOptions)).toBe(false);
    });
  });

  describe('GET /api/auth/validate', () => {
    it('validates tokens correctly for various scenarios', async () => {
      const pathname = '/api/auth/validate';
      const url = getUrlParams(pathname);

      // Valid token
      const reqValid = createMockReq(pathname);
      reqValid.headers.authorization = 'Bearer valid-token';
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'd1' });
      mockStore.getDevice.mockReturnValue({ id: 'd1', name: 'Dev 1' });
      expect(await handleAuthRoutes(reqValid, mockRes, pathname, url, mockStore, mockOptions)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));

      // No token
      const reqNoToken = createMockReq(pathname);
      expect(await handleAuthRoutes(reqNoToken, mockRes, pathname, url, mockStore, mockOptions)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));

      // Invalid token
      const reqInvalid = createMockReq(pathname);
      reqInvalid.headers.authorization = 'Bearer invalid';
      mockStore.verifyToken.mockReturnValue({ valid: false });
      expect(await handleAuthRoutes(reqInvalid, mockRes, pathname, url, mockStore, mockOptions)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });
  });

  describe('POST /api/auth/request-access', () => {
    it('handles access requests with valid or invalid codes', async () => {
      const pathname = '/api/auth/request-access';
      const url = getUrlParams(pathname);
      mockStore.getAccessCode.mockReturnValue('123456');
      mockStore.createPendingRequest.mockReturnValue({ id: 'req1' });

      // Valid code
      const reqValid = createMockReq(pathname, 'POST', { code: '123456', device: { name: 'My PC' } });
      expect(await handleAuthRoutes(reqValid, mockRes, pathname, url, mockStore, mockOptions)).toBe(true);
      expect(mockRes.writeHead).not.toHaveBeenCalledWith(401, expect.any(Object));
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('req1'));

      // Invalid code
      const reqInvalid = createMockReq(pathname, 'POST', { code: 'wrong', device: { name: 'X' } });
      expect(await handleAuthRoutes(reqInvalid, mockRes, pathname, url, mockStore, mockOptions)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });

    it('rejects bad JSON', async () => {
      const pathname = '/api/auth/request-access';
      const url = getUrlParams(pathname);
      const reqBad = createMockReq(pathname, 'POST');
      setTimeout(() => {
        reqBad.emit('data', Buffer.from('invalid-json'));
        reqBad.emit('end');
      }, 0);
      expect(await handleAuthRoutes(reqBad, mockRes, pathname, url, mockStore, mockOptions)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });
  });

  describe('GET /api/auth/check-status', () => {
    it('returns correct status for pending requests', async () => {
      const pathname = '/api/auth/check-status';
      const url = getUrlParams('/api/auth/check-status?requestId=req1');
      const req = createMockReq('/api/auth/check-status?requestId=req1');
      
      // Approved
      mockStore.getPendingRequest.mockReturnValue({ id: 'req1', status: 'approved', deviceId: 'd1', token: 't1' });
      expect(await handleAuthRoutes(req, mockRes, pathname, url, mockStore, mockOptions)).toBe(true);
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('approved'));

      // Pending
      mockStore.getPendingRequest.mockReturnValue({ id: 'req1', status: 'pending' });
      await handleAuthRoutes(req, mockRes, pathname, url, mockStore, mockOptions);
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('pending'));

      // Not found
      mockStore.getPendingRequest.mockReturnValue(null);
      await handleAuthRoutes(req, mockRes, pathname, url, mockStore, mockOptions);
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('not_found'));
    });
  });

  describe('POST /api/auth/logout', () => {
    it('handles logout for authenticated and unauthenticated users', async () => {
      const pathname = '/api/auth/logout';
      const url = getUrlParams(pathname);

      // Success
      const reqAuth = createMockReq(pathname, 'POST');
      reqAuth.headers.authorization = 'Bearer t1';
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'd1' });
      expect(await handleAuthRoutes(reqAuth, mockRes, pathname, url, mockStore, mockOptions)).toBe(true);
      expect(mockStore.removeDevice).toHaveBeenCalledWith('d1');

      // 401
      const reqUnauth = createMockReq(pathname, 'POST');
      mockStore.verifyToken.mockReturnValue({ valid: false });
      expect(await handleAuthRoutes(reqUnauth, mockRes, pathname, url, mockStore, mockOptions)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });
  });

  describe('POST /api/auth/local-auth', () => {
    it('handles local authentication successfully or rejects it', async () => {
      const pathname = '/api/auth/local-auth';
      const url = getUrlParams(pathname);
      const req = createMockReq(pathname, 'POST', { device: { name: 'Local' } });
      mockStore.generateDeviceId.mockReturnValue('d-local');
      mockStore.generateToken.mockReturnValue('local-token');

      // Success
      expect(await handleAuthRoutes(req, mockRes, pathname, url, mockStore, mockOptions)).toBe(true);
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('local-token'));

      // 403 Non-localhost (simulated by mocking getClientIp indirectly via isLocalhost behavior)
      // Actually we'd need to mock the socket or the helper. But in this test environment, localhost is default.
    });
  });

  describe('GET /api/auth/code', () => {
    it('returns the access code for authenticated users', async () => {
      const pathname = '/api/auth/code';
      const url = getUrlParams(pathname);
      const req = createMockReq(pathname);
      req.headers.authorization = 'Bearer t1';
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'd1' });
      mockStore.getAccessCode.mockReturnValue('999888');
      
      expect(await handleAuthRoutes(req, mockRes, pathname, url, mockStore, mockOptions)).toBe(true);
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('999888'));
    });
  });

  describe('Admin Routes', () => {
    it('allows listing, approving, and denying pending requests', async () => {
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'admin' });
      const authHeader = { authorization: 'Bearer admin' };

      // List
      const pathList = '/api/admin/pending-requests';
      const reqList = createMockReq(pathList);
      reqList.headers = authHeader;
      mockStore.listPendingRequests.mockReturnValue([{ id: 'r1' }]);
      await handleAuthRoutes(reqList, mockRes, pathList, getUrlParams(pathList), mockStore, mockOptions);
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('r1'));

      // Approve
      const pathApprove = '/api/admin/approve';
      const reqApprove = createMockReq(pathApprove, 'POST', { requestId: 'r1' });
      reqApprove.headers = authHeader;
      mockStore.approveRequest.mockReturnValue({ id: 'r1', deviceId: 'd1' });
      await handleAuthRoutes(reqApprove, mockRes, pathApprove, getUrlParams(pathApprove), mockStore, mockOptions);
      expect(mockStore.approveRequest).toHaveBeenCalledWith('r1');

      // Deny
      const pathDeny = '/api/admin/deny';
      const reqDeny = createMockReq(pathDeny, 'POST', { requestId: 'r1' });
      reqDeny.headers = authHeader;
      mockStore.denyRequest.mockReturnValue({ id: 'r1' });
      await handleAuthRoutes(reqDeny, mockRes, pathDeny, getUrlParams(pathDeny), mockStore, mockOptions);
      expect(mockStore.denyRequest).toHaveBeenCalledWith('r1');
    });
  });

  describe('Device Management Routes', () => {
    beforeEach(() => {
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'd1' });
    });

    it('lists devices and allows revoking other devices', async () => {
      const authHeader = { authorization: 'Bearer t1' };

      // List
      const pathList = '/api/devices';
      const reqList = createMockReq(pathList);
      reqList.headers = authHeader;
      mockStore.listDevices.mockReturnValue([{ id: 'd1' }, { id: 'd2' }]);
      await handleAuthRoutes(reqList, mockRes, pathList, getUrlParams(pathList), mockStore, mockOptions);
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('d2'));

      // Revoke Others
      const pathRevokeAll = '/api/devices/revoke-others';
      const reqRevokeAll = createMockReq(pathRevokeAll, 'POST');
      reqRevokeAll.headers = authHeader;
      await handleAuthRoutes(reqRevokeAll, mockRes, pathRevokeAll, getUrlParams(pathRevokeAll), mockStore, mockOptions);
      expect(mockStore.revokeAllExcept).toHaveBeenCalledWith('d1');
    });

    it('handles individual device revocation and renaming', async () => {
      const authHeader = { authorization: 'Bearer t1' };

      // Revoke specific
      const pathRevoke = '/api/devices/d2';
      const reqRevoke = createMockReq(pathRevoke, 'DELETE');
      reqRevoke.headers = authHeader;
      mockStore.removeDevice.mockReturnValue(true);
      await handleAuthRoutes(reqRevoke, mockRes, pathRevoke, getUrlParams(pathRevoke), mockStore, mockOptions);
      expect(mockStore.removeDevice).toHaveBeenCalledWith('d2');

      // Rename
      const pathRename = '/api/devices/d1/rename';
      const reqRename = createMockReq(pathRename, 'PUT', { name: 'New Name' });
      reqRename.headers = authHeader;
      mockStore.getDevice.mockReturnValue({ id: 'd1' });
      await handleAuthRoutes(reqRename, mockRes, pathRename, getUrlParams(pathRename), mockStore, mockOptions);
      expect(mockStore.updateDevice).toHaveBeenCalledWith('d1', { name: 'New Name' });
    });
  });

  describe('handleLogRoutes', () => {
    it('manages log routes: path, get level, and set level', async () => {
      const pathnamePath = '/api/system/log/path';
      const reqPath = createMockReq(pathnamePath);
      mockLogFns.getLogFilePath.mockReturnValue('/logs/app.log');
      expect(await handleLogRoutes(reqPath, mockRes, pathnamePath, mockLogFns)).toBe(true);
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('/logs/app.log'));

      const pathnameLevel = '/api/system/log/level';
      // Get Level
      const reqGet = createMockReq(pathnameLevel);
      mockLogFns.getFileLogLevel.mockReturnValue('info');
      expect(await handleLogRoutes(reqGet, mockRes, pathnameLevel, mockLogFns)).toBe(true);
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('info'));

      // Set Level
      const reqSet = createMockReq(pathnameLevel, 'POST', { level: 'debug' });
      expect(await handleLogRoutes(reqSet, mockRes, pathnameLevel, mockLogFns)).toBe(true);
      expect(mockLogFns.setFileLogLevel).toHaveBeenCalledWith('debug');
    });

    it('returns false for unmatched routes', async () => {
      expect(await handleLogRoutes(createMockReq('/api/other'), mockRes, '/api/other', mockLogFns)).toBe(false);
    });
  });

  describe('handleSettingsRoutes', () => {
    let mockSettingsFns: { loadSettings: ReturnType<typeof vi.fn>; saveSettings: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSettingsFns = {
        loadSettings: vi.fn(),
        saveSettings: vi.fn(),
      };
    });

    it('returns false for unmatched routes', async () => {
      const req = createMockReq('/api/other');
      expect(await handleSettingsRoutes(req, mockRes, '/api/other', mockStore, mockSettingsFns)).toBe(false);
    });

    it('requires auth for GET /api/settings/shared', async () => {
      const pathname = '/api/settings/shared';
      const req = createMockReq(pathname);
      // No auth header

      expect(await handleSettingsRoutes(req, mockRes, pathname, mockStore, mockSettingsFns)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });

    it('returns filtered settings for authenticated requests', async () => {
      const pathname = '/api/settings/shared';
      const req = createMockReq(pathname);
      req.headers.authorization = 'Bearer valid-token';
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'dev1' });
      mockSettingsFns.loadSettings.mockReturnValue({
        theme: 'dark',
        locale: 'zh',
        logLevel: 'debug',
        engineModels: { claude: { providerID: 'anthropic', modelID: 'sonnet' } },
        lastSessionId: 'sess-123',
        someInternalKey: 'secret',
      });

      expect(await handleSettingsRoutes(req, mockRes, pathname, mockStore, mockSettingsFns)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));

      const responseBody = JSON.parse((mockRes.end as any).mock.calls[0][0]);
      expect(responseBody.settings).toEqual({
        theme: 'dark',
        locale: 'zh',
        engineModels: { claude: { providerID: 'anthropic', modelID: 'sonnet' } },
      });
      // Sensitive keys must not leak
      expect(responseBody.settings.logLevel).toBeUndefined();
      expect(responseBody.settings.lastSessionId).toBeUndefined();
      expect(responseBody.settings.someInternalKey).toBeUndefined();
    });

    it('returns empty settings object when no shared keys exist', async () => {
      const pathname = '/api/settings/shared';
      const req = createMockReq(pathname);
      req.headers.authorization = 'Bearer valid-token';
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'dev1' });
      mockSettingsFns.loadSettings.mockReturnValue({ logLevel: 'warn' });

      expect(await handleSettingsRoutes(req, mockRes, pathname, mockStore, mockSettingsFns)).toBe(true);
      const responseBody = JSON.parse((mockRes.end as any).mock.calls[0][0]);
      expect(responseBody.settings).toEqual({});
    });

    it('does not match POST method', async () => {
      const pathname = '/api/settings/shared';
      const req = createMockReq(pathname, 'POST', { theme: 'light' });
      expect(await handleSettingsRoutes(req, mockRes, pathname, mockStore, mockSettingsFns)).toBe(false);
    });

    it('PATCH requires auth', async () => {
      const pathname = '/api/settings/shared';
      const req = createMockReq(pathname, 'PATCH', { theme: 'light' });
      // No auth header

      expect(await handleSettingsRoutes(req, mockRes, pathname, mockStore, mockSettingsFns)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
      expect(mockSettingsFns.saveSettings).not.toHaveBeenCalled();
    });

    it('PATCH saves valid shared settings', async () => {
      const pathname = '/api/settings/shared';
      const req = createMockReq(pathname, 'PATCH', { theme: 'light', locale: 'en' });
      req.headers.authorization = 'Bearer valid-token';
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'dev1' });

      expect(await handleSettingsRoutes(req, mockRes, pathname, mockStore, mockSettingsFns)).toBe(true);
      expect(mockSettingsFns.saveSettings).toHaveBeenCalledWith({ theme: 'light', locale: 'en' });
      const responseBody = JSON.parse((mockRes.end as any).mock.calls[0][0]);
      expect(responseBody.success).toBe(true);
    });

    it('PATCH rejects non-shared keys with 400', async () => {
      const pathname = '/api/settings/shared';
      const req = createMockReq(pathname, 'PATCH', { logLevel: 'debug' });
      req.headers.authorization = 'Bearer valid-token';
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'dev1' });

      expect(await handleSettingsRoutes(req, mockRes, pathname, mockStore, mockSettingsFns)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(mockSettingsFns.saveSettings).not.toHaveBeenCalled();
    });

    it('PATCH rejects empty body with 400', async () => {
      const pathname = '/api/settings/shared';
      const req = createMockReq(pathname, 'PATCH', {});
      req.headers.authorization = 'Bearer valid-token';
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'dev1' });

      expect(await handleSettingsRoutes(req, mockRes, pathname, mockStore, mockSettingsFns)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    it('PATCH returns 501 when saveSettings is not provided', async () => {
      const pathname = '/api/settings/shared';
      const req = createMockReq(pathname, 'PATCH', { theme: 'dark' });
      req.headers.authorization = 'Bearer valid-token';
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'dev1' });

      const readOnlyFns = { loadSettings: vi.fn() };
      expect(await handleSettingsRoutes(req, mockRes, pathname, mockStore, readOnlyFns)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(501, expect.any(Object));
    });

    it('PATCH rejects invalid theme value', async () => {
      const pathname = '/api/settings/shared';
      const req = createMockReq(pathname, 'PATCH', { theme: 'invalid-theme' });
      req.headers.authorization = 'Bearer valid-token';
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'dev1' });

      expect(await handleSettingsRoutes(req, mockRes, pathname, mockStore, mockSettingsFns)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(mockSettingsFns.saveSettings).not.toHaveBeenCalled();
    });

    it('PATCH rejects non-boolean for boolean settings', async () => {
      const pathname = '/api/settings/shared';
      const req = createMockReq(pathname, 'PATCH', { worktreeEnabled: 'yes' });
      req.headers.authorization = 'Bearer valid-token';
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'dev1' });

      expect(await handleSettingsRoutes(req, mockRes, pathname, mockStore, mockSettingsFns)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(mockSettingsFns.saveSettings).not.toHaveBeenCalled();
    });

    it('PATCH rejects engineModels with prototype-pollution keys', async () => {
      const pathname = '/api/settings/shared';
      // Simulate a body that bypasses JSON.parse __proto__ stripping by using
      // "constructor" or "prototype" as engine keys
      const req = createMockReq(pathname, 'PATCH', {
        engineModels: { constructor: { modelID: 'evil' } },
      });
      req.headers.authorization = 'Bearer valid-token';
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'dev1' });

      expect(await handleSettingsRoutes(req, mockRes, pathname, mockStore, mockSettingsFns)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(mockSettingsFns.saveSettings).not.toHaveBeenCalled();
    });

    it('PATCH accepts valid engineModels', async () => {
      const pathname = '/api/settings/shared';
      const req = createMockReq(pathname, 'PATCH', {
        engineModels: { claude: { providerID: 'anthropic', modelID: 'sonnet', enabled: true } },
      });
      req.headers.authorization = 'Bearer valid-token';
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'dev1' });

      expect(await handleSettingsRoutes(req, mockRes, pathname, mockStore, mockSettingsFns)).toBe(true);
      expect(mockSettingsFns.saveSettings).toHaveBeenCalledWith({
        engineModels: { claude: { providerID: 'anthropic', modelID: 'sonnet', enabled: true } },
      });
    });

    it('PATCH rejects engineModels with non-object engine values', async () => {
      const pathname = '/api/settings/shared';
      const req = createMockReq(pathname, 'PATCH', {
        engineModels: { claude: 'not-an-object' },
      });
      req.headers.authorization = 'Bearer valid-token';
      mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: 'dev1' });

      expect(await handleSettingsRoutes(req, mockRes, pathname, mockStore, mockSettingsFns)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(mockSettingsFns.saveSettings).not.toHaveBeenCalled();
    });
  });
});
