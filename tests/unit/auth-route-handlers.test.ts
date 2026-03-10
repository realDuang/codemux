import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleAuthRoutes, handleLogRoutes } from "../../shared/auth-route-handlers";
import { EventEmitter } from "events";
import type { IncomingMessage, ServerResponse } from "http";
import type { DeviceInfo, PendingRequest } from "../../shared/device-store-types";

// --- Mocks ---

function createMockReq(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  remoteAddress?: string;
} = {}): IncomingMessage & EventEmitter {
  const req = new EventEmitter() as any;
  req.method = options.method || "GET";
  req.headers = options.headers || {};
  req.socket = { remoteAddress: options.remoteAddress || "127.0.0.1" };
  
  if (options.body) {
    process.nextTick(() => {
      req.emit("data", Buffer.from(JSON.stringify(options.body)));
      req.emit("end");
    });
  } else if (options.method === "POST" || options.method === "PUT") {
    // If it's a POST/PUT without body, still emit end
    process.nextTick(() => {
      req.emit("end");
    });
  }

  return req;
}

function createMockRes() {
  const res = {
    writeHead: vi.fn(),
    end: vi.fn().mockImplementation((body) => {
      res._body = body;
    }),
    _body: "",
    _status: 200,
  } as any;

  res.writeHead.mockImplementation((status) => {
    res._status = status;
  });

  return res;
}

const mockStore = {
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

const localAuthOptions = {
  defaultDeviceName: "Test Device",
  defaultPlatform: "test",
  defaultBrowser: "test-browser",
  includeDeviceInResponse: false,
};

describe("auth-route-handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("handleAuthRoutes", () => {
    it("returns false for unmatched routes", async () => {
      const req = createMockReq({ method: "GET" });
      const res = createMockRes();
      const url = new URL("http://localhost/api/unknown");
      const handled = await handleAuthRoutes(req, res, "/api/unknown", url, mockStore as any, localAuthOptions);
      expect(handled).toBe(false);
    });

    it("returns false for wrong method on valid path", async () => {
      const req = createMockReq({ method: "POST" });
      const res = createMockRes();
      const url = new URL("http://localhost/api/auth/validate");
      const handled = await handleAuthRoutes(req, res, "/api/auth/validate", url, mockStore as any, localAuthOptions);
      expect(handled).toBe(false);
    });

    describe("GET /api/auth/validate", () => {
      it("validates token and returns device info", async () => {
        const req = createMockReq({ headers: { authorization: "Bearer valid-token" } });
        const res = createMockRes();
        const url = new URL("http://localhost/api/auth/validate");
        
        mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: "dev-1" });
        mockStore.getDevice.mockReturnValue({ id: "dev-1", name: "My Device" });

        const handled = await handleAuthRoutes(req, res, "/api/auth/validate", url, mockStore as any, localAuthOptions);
        
        expect(handled).toBe(true);
        expect(res._status).toBe(200);
        const body = JSON.parse(res._body);
        expect(body.valid).toBe(true);
        expect(body.deviceId).toBe("dev-1");
        expect(body.device.name).toBe("My Device");
      });

      it("returns 401 if no token provided", async () => {
        const req = createMockReq();
        const res = createMockRes();
        const url = new URL("http://localhost/api/auth/validate");
        
        const handled = await handleAuthRoutes(req, res, "/api/auth/validate", url, mockStore as any, localAuthOptions);
        
        expect(handled).toBe(true);
        expect(res._status).toBe(401);
        expect(JSON.parse(res._body).error).toBe("No token provided");
      });

      it("returns 401 if token is invalid", async () => {
        const req = createMockReq({ headers: { authorization: "Bearer invalid" } });
        const res = createMockRes();
        const url = new URL("http://localhost/api/auth/validate");
        
        mockStore.verifyToken.mockReturnValue({ valid: false });

        const handled = await handleAuthRoutes(req, res, "/api/auth/validate", url, mockStore as any, localAuthOptions);
        
        expect(handled).toBe(true);
        expect(res._status).toBe(401);
        expect(JSON.parse(res._body).error).toBe("Invalid or expired token");
      });
    });

    describe("POST /api/auth/request-access", () => {
      it("creates pending request if code is valid", async () => {
        const req = createMockReq({ 
          method: "POST", 
          body: { code: "123456", device: { name: "New Dev" } } 
        });
        const res = createMockRes();
        const url = new URL("http://localhost/api/auth/request-access");
        
        mockStore.getAccessCode.mockReturnValue("123456");
        mockStore.createPendingRequest.mockReturnValue({ id: "req-1" });

        const handled = await handleAuthRoutes(req, res, "/api/auth/request-access", url, mockStore as any, localAuthOptions);
        
        expect(handled).toBe(true);
        expect(res._status).toBe(200);
        expect(JSON.parse(res._body).requestId).toBe("req-1");
        expect(mockStore.createPendingRequest).toHaveBeenCalledWith(
          expect.objectContaining({ name: "New Dev" }),
          expect.any(String)
        );
      });

      it("returns 401 if code is invalid", async () => {
        const req = createMockReq({ 
          method: "POST", 
          body: { code: "wrong", device: {} } 
        });
        const res = createMockRes();
        const url = new URL("http://localhost/api/auth/request-access");
        
        mockStore.getAccessCode.mockReturnValue("123456");

        const handled = await handleAuthRoutes(req, res, "/api/auth/request-access", url, mockStore as any, localAuthOptions);
        
        expect(handled).toBe(true);
        expect(res._status).toBe(401);
        expect(JSON.parse(res._body).error).toBe("Invalid code");
      });

      it("returns 400 for bad JSON", async () => {
        const req = new EventEmitter() as any;
        req.method = "POST";
        req.headers = {};
        req.socket = { remoteAddress: "127.0.0.1" };
        
        const res = createMockRes();
        const url = new URL("http://localhost/api/auth/request-access");

        // Start processing
        const promise = handleAuthRoutes(req, res, "/api/auth/request-access", url, mockStore as any, localAuthOptions);
        
        // Emit bad data
        req.emit("data", "invalid-json");
        req.emit("end");

        const handled = await promise;
        
        expect(handled).toBe(true);
        expect(res._status).toBe(400);
      });
    });

    describe("GET /api/auth/check-status", () => {
      it("returns approved status with token", async () => {
        const req = createMockReq();
        const res = createMockRes();
        const url = new URL("http://localhost/api/auth/check-status?requestId=req-1");
        
        mockStore.getPendingRequest.mockReturnValue({ status: "approved", token: "tok-1", deviceId: "dev-1" });

        const handled = await handleAuthRoutes(req, res, "/api/auth/check-status", url, mockStore as any, localAuthOptions);
        
        expect(handled).toBe(true);
        const body = JSON.parse(res._body);
        expect(body.status).toBe("approved");
        expect(body.token).toBe("tok-1");
      });

      it("returns pending status", async () => {
        const req = createMockReq();
        const res = createMockRes();
        const url = new URL("http://localhost/api/auth/check-status?requestId=req-1");
        
        mockStore.getPendingRequest.mockReturnValue({ status: "pending" });

        const handled = await handleAuthRoutes(req, res, "/api/auth/check-status", url, mockStore as any, localAuthOptions);
        
        expect(handled).toBe(true);
        expect(JSON.parse(res._body).status).toBe("pending");
      });

      it("returns not_found if requestId is missing or invalid", async () => {
        const res1 = createMockRes();
        const url1 = new URL("http://localhost/api/auth/check-status");
        await handleAuthRoutes(createMockReq(), res1, "/api/auth/check-status", url1, mockStore as any, localAuthOptions);
        expect(JSON.parse(res1._body).status).toBe("not_found");

        const res2 = createMockRes();
        const url2 = new URL("http://localhost/api/auth/check-status?requestId=missing");
        mockStore.getPendingRequest.mockReturnValue(undefined);
        await handleAuthRoutes(createMockReq(), res2, "/api/auth/check-status", url2, mockStore as any, localAuthOptions);
        expect(JSON.parse(res2._body).status).toBe("not_found");
      });
    });

    describe("POST /api/auth/logout", () => {
      it("removes device and returns success", async () => {
        const req = createMockReq({ method: "POST", headers: { authorization: "Bearer tok-1" } });
        const res = createMockRes();
        mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: "dev-1" });

        const handled = await handleAuthRoutes(req, res, "/api/auth/logout", new URL("http://l/api/auth/logout"), mockStore as any, localAuthOptions);
        
        expect(handled).toBe(true);
        expect(mockStore.removeDevice).toHaveBeenCalledWith("dev-1");
        expect(JSON.parse(res._body).success).toBe(true);
      });

      it("returns 401 for invalid token", async () => {
        const req = createMockReq({ method: "POST", headers: { authorization: "Bearer invalid" } });
        const res = createMockRes();
        mockStore.verifyToken.mockReturnValue({ valid: false });

        await handleAuthRoutes(req, res, "/api/auth/logout", new URL("http://l/api/auth/logout"), mockStore as any, localAuthOptions);
        expect(res._status).toBe(401);
      });
    });

    describe("POST /api/auth/local-auth", () => {
      it("creates device and returns token for localhost", async () => {
        const req = createMockReq({ 
          method: "POST", 
          remoteAddress: "127.0.0.1",
          body: { device: { name: "Local" } } 
        });
        const res = createMockRes();
        
        mockStore.generateDeviceId.mockReturnValue("dev-local");
        mockStore.generateToken.mockReturnValue("tok-local");

        const handled = await handleAuthRoutes(req, res, "/api/auth/local-auth", new URL("http://l/api/auth/local-auth"), mockStore as any, localAuthOptions);
        
        expect(handled).toBe(true);
        expect(res._status).toBe(200);
        const body = JSON.parse(res._body);
        expect(body.token).toBe("tok-local");
        expect(mockStore.addDevice).toHaveBeenCalled();
      });

      it("returns 403 for non-localhost", async () => {
        const req = createMockReq({ method: "POST", remoteAddress: "1.1.1.1" });
        const res = createMockRes();
        
        await handleAuthRoutes(req, res, "/api/auth/local-auth", new URL("http://l/api/auth/local-auth"), mockStore as any, localAuthOptions);
        expect(res._status).toBe(403);
      });
    });

    describe("GET /api/auth/code", () => {
      it("returns access code when authenticated", async () => {
        const req = createMockReq({ headers: { authorization: "Bearer tok-1" } });
        const res = createMockRes();
        mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: "dev-1" });
        mockStore.getAccessCode.mockReturnValue("654321");

        const handled = await handleAuthRoutes(req, res, "/api/auth/code", new URL("http://l/api/auth/code"), mockStore as any, localAuthOptions);
        
        expect(handled).toBe(true);
        expect(JSON.parse(res._body).code).toBe("654321");
      });

      it("returns 401 when not authenticated", async () => {
        const req = createMockReq();
        const res = createMockRes();
        await handleAuthRoutes(req, res, "/api/auth/code", new URL("http://l/api/auth/code"), mockStore as any, localAuthOptions);
        expect(res._status).toBe(401);
      });
    });

    describe("Admin routes", () => {
      const authHeaders = { authorization: "Bearer admin-tok" };
      
      beforeEach(() => {
        mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: "admin-dev" });
      });

      it("GET /api/admin/pending-requests lists requests", async () => {
        const req = createMockReq({ headers: authHeaders });
        const res = createMockRes();
        mockStore.listPendingRequests.mockReturnValue([{ id: "req-1" }]);

        await handleAuthRoutes(req, res, "/api/admin/pending-requests", new URL("http://l/api/admin/pending-requests"), mockStore as any, localAuthOptions);
        
        expect(JSON.parse(res._body).requests).toHaveLength(1);
      });

      it("POST /api/admin/approve approves request", async () => {
        const req = createMockReq({ 
          method: "POST", 
          headers: authHeaders,
          body: { requestId: "req-1" } 
        });
        const res = createMockRes();
        mockStore.approveRequest.mockReturnValue({ id: "req-1", deviceId: "dev-new" });
        mockStore.getDevice.mockReturnValue({ id: "dev-new", name: "New" });

        await handleAuthRoutes(req, res, "/api/admin/approve", new URL("http://l/api/admin/approve"), mockStore as any, localAuthOptions);
        
        expect(JSON.parse(res._body).success).toBe(true);
        expect(mockStore.approveRequest).toHaveBeenCalledWith("req-1");
      });

      it("POST /api/admin/deny denies request", async () => {
        const req = createMockReq({ 
          method: "POST", 
          headers: authHeaders,
          body: { requestId: "req-1" } 
        });
        const res = createMockRes();
        mockStore.denyRequest.mockReturnValue({ id: "req-1" });

        await handleAuthRoutes(req, res, "/api/admin/deny", new URL("http://l/api/admin/deny"), mockStore as any, localAuthOptions);
        
        expect(JSON.parse(res._body).success).toBe(true);
      });

      it("returns 404 for approve/deny if request not found", async () => {
        const req = createMockReq({ method: "POST", headers: authHeaders, body: { requestId: "none" } });
        const res = createMockRes();
        mockStore.approveRequest.mockReturnValue(undefined);

        await handleAuthRoutes(req, res, "/api/admin/approve", new URL("http://l/api/admin/approve"), mockStore as any, localAuthOptions);
        expect(res._status).toBe(404);
      });
    });

    describe("Device routes", () => {
      const authHeaders = { authorization: "Bearer tok1" };
      
      beforeEach(() => {
        mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: "dev1" });
      });

      it("GET /api/devices lists devices", async () => {
        const req = createMockReq({ headers: authHeaders });
        const res = createMockRes();
        mockStore.listDevices.mockReturnValue([{ id: "dev1" }, { id: "dev2" }]);

        await handleAuthRoutes(req, res, "/api/devices", new URL("http://l/api/devices"), mockStore as any, localAuthOptions);
        
        const body = JSON.parse(res._body);
        expect(body.devices).toHaveLength(2);
        expect(body.currentDeviceId).toBe("dev1");
      });

      it("POST /api/devices/revoke-others revokes all except current", async () => {
        const req = createMockReq({ method: "POST", headers: authHeaders });
        const res = createMockRes();
        mockStore.revokeAllExcept.mockReturnValue(5);

        await handleAuthRoutes(req, res, "/api/devices/revoke-others", new URL("http://l/api/devices/revoke-others"), mockStore as any, localAuthOptions);
        
        expect(JSON.parse(res._body).revokedCount).toBe(5);
        expect(mockStore.revokeAllExcept).toHaveBeenCalledWith("dev1");
      });

      it("DELETE /api/devices/:id revokes specific device", async () => {
        const req = createMockReq({ method: "DELETE", headers: authHeaders });
        const res = createMockRes();
        mockStore.removeDevice.mockReturnValue(true);

        const pathname = "/api/devices/abcdef0123456789";
        const url = new URL(`http://localhost${pathname}`);
        const handled = await handleAuthRoutes(req, res, pathname, url, mockStore as any, localAuthOptions);
        
        expect(handled).toBe(true);
        expect(JSON.parse(res._body).success).toBe(true);
        expect(mockStore.removeDevice).toHaveBeenCalledWith("abcdef0123456789");
      });

      it("DELETE /api/devices/:id returns 400 when revoking current device", async () => {
        const req = createMockReq({ method: "DELETE", headers: authHeaders });
        const res = createMockRes();

        const pathname = "/api/devices/abcdef0123456789";
        // Need to set deviceId to match current device for this test
        mockStore.verifyToken.mockReturnValue({ valid: true, deviceId: "abcdef0123456789" });
        
        const url = new URL(`http://localhost${pathname}`);
        const handled = await handleAuthRoutes(req, res, pathname, url, mockStore as any, localAuthOptions);
        
        expect(handled).toBe(true);
        expect(res._status).toBe(400);
        expect(JSON.parse(res._body).error).toContain("Use logout instead");
      });

      it("PUT /api/devices/:id/rename renames device", async () => {
        const req = createMockReq({ 
          method: "PUT", 
          headers: authHeaders,
          body: { name: "New Name" } 
        });
        const res = createMockRes();
        mockStore.getDevice.mockReturnValue({ id: "abcdef0123456789", name: "Old" });

        const pathname = "/api/devices/abcdef0123456789/rename";
        const url = new URL(`http://localhost${pathname}`);
        const handled = await handleAuthRoutes(req, res, pathname, url, mockStore as any, localAuthOptions);
        
        expect(handled).toBe(true);
        expect(mockStore.updateDevice).toHaveBeenCalledWith("abcdef0123456789", { name: "New Name" });
        expect(JSON.parse(res._body).success).toBe(true);
      });
      
      it("PUT /api/devices/:id/rename returns 400 for empty name", async () => {
        const req = createMockReq({ method: "PUT", headers: authHeaders, body: { name: "" } });
        const res = createMockRes();
        const pathname = "/api/devices/abcdef0123456789/rename";
        const url = new URL(`http://localhost${pathname}`);
        const handled = await handleAuthRoutes(req, res, pathname, url, mockStore as any, localAuthOptions);
        expect(handled).toBe(true);
        expect(res._status).toBe(400);
      });
    });
  });

  describe("handleLogRoutes", () => {
    const logFns = {
      getLogFilePath: vi.fn(),
      getFileLogLevel: vi.fn(),
      setFileLogLevel: vi.fn(),
    };

    it("GET /api/system/log/path returns path for localhost", async () => {
      const req = createMockReq({ remoteAddress: "127.0.0.1" });
      const res = createMockRes();
      logFns.getLogFilePath.mockReturnValue("/path/to/log");

      const handled = await handleLogRoutes(req, res, "/api/system/log/path", logFns);
      
      expect(handled).toBe(true);
      expect(JSON.parse(res._body).path).toBe("/path/to/log");
    });

    it("GET /api/system/log/level returns level", async () => {
      const req = createMockReq({ remoteAddress: "127.0.0.1" });
      const res = createMockRes();
      logFns.getFileLogLevel.mockReturnValue("info");

      await handleLogRoutes(req, res, "/api/system/log/level", logFns);
      expect(JSON.parse(res._body).level).toBe("info");
    });

    it("POST /api/system/log/level sets level", async () => {
      const req = createMockReq({ 
        method: "POST", 
        remoteAddress: "127.0.0.1",
        body: { level: "debug" } 
      });
      const res = createMockRes();

      await handleLogRoutes(req, res, "/api/system/log/level", logFns);
      
      expect(logFns.setFileLogLevel).toHaveBeenCalledWith("debug");
      expect(JSON.parse(res._body).success).toBe(true);
    });

    it("returns 403 for non-localhost", async () => {
      const req = createMockReq({ remoteAddress: "1.2.3.4" });
      const res = createMockRes();
      
      await handleLogRoutes(req, res, "/api/system/log/path", logFns);
      expect(res._status).toBe(403);
    });

    it("returns false for unmatched log routes", async () => {
      const req = createMockReq();
      const res = createMockRes();
      const handled = await handleLogRoutes(req, res, "/api/system/other", logFns);
      expect(handled).toBe(false);
    });
  });
});
