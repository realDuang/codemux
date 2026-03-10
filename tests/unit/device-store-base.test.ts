import fs from "fs";
import path from "path";
import os from "os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeviceStoreBase } from "../../shared/device-store-base";
import type { DeviceInfo } from "../../shared/device-store-types";

class TestDeviceStore extends DeviceStoreBase {
  private filePath: string;
  constructor(filePath: string) {
    super();
    this.filePath = filePath;
    this.loadData();
  }
  protected getFilePath(): string {
    return this.filePath;
  }
  
  // Public wrapper for testing protected methods if needed
  public testGetData() {
    return this.getData();
  }

  // Override beforeRead for testing purposes if needed
  private beforeReadCalled = 0;
  private disableBeforeRead = false;
  protected override beforeRead(): void {
    if (this.disableBeforeRead) return;
    this.beforeReadCalled++;
  }
  public setDisableBeforeRead(val: boolean) {
    this.disableBeforeRead = val;
  }
  public getBeforeReadCount() {
    return this.beforeReadCalled;
  }
}

describe("DeviceStoreBase", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: TestDeviceStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-store-test-"));
    dbPath = path.join(tmpDir, "devices.json");
    store = new TestDeviceStore(dbPath);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("Initialization & Persistence", () => {
    it("constructor creates file if it doesn't exist", () => {
      expect(fs.existsSync(dbPath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
      expect(data.devices).toEqual({});
      expect(data.jwtSecret).toBeDefined();
    });

    it("constructor loads existing valid file", () => {
      const existingData = {
        devices: { "dev1": { id: "dev1", name: "Test" } },
        pendingRequests: {},
        jwtSecret: "test-secret"
      };
      fs.writeFileSync(dbPath, JSON.stringify(existingData));
      
      const newStore = new TestDeviceStore(dbPath);
      expect(newStore.getDevice("dev1")).toBeDefined();
      expect(newStore.testGetData().jwtSecret).toBe("test-secret");
    });

    it("constructor handles corrupt JSON by falling back to empty", () => {
      fs.writeFileSync(dbPath, "invalid json {");
      const newStore = new TestDeviceStore(dbPath);
      expect(newStore.listDevices()).toHaveLength(0);
      expect(fs.existsSync(dbPath)).toBe(true);
      // Verify it overwrote with valid empty data
      const content = fs.readFileSync(dbPath, "utf-8");
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it("reload() re-reads from disk", () => {
      const device: DeviceInfo = {
        id: "d1", name: "N1", platform: "P1", browser: "B1", 
        createdAt: Date.now(), lastSeenAt: Date.now(), ip: "127.0.0.1"
      };
      
      // Manually modify file
      const data = store.testGetData();
      const updatedData = {
        ...data,
        devices: {
          ...data.devices,
          "d1": device
        }
      };
      fs.writeFileSync(dbPath, JSON.stringify(updatedData));
      
      // Before reload, the in-memory 'data' object shouldn't have 'd1'
      // We check the internal state directly to avoid triggering any hooks
      expect(store.testGetData().devices["d1"]).toBeUndefined();
      
      store.reload();
      expect(store.getDevice("d1")).toBeDefined();
    });

    it("getData() throws if not initialized", () => {
      class UninitializedStore extends DeviceStoreBase {
        protected getFilePath(): string { return dbPath; }
        public triggerGetData() { return this.getData(); }
      }
      const uStore = new UninitializedStore();
      expect(() => uStore.triggerGetData()).toThrow("DeviceStore not initialized");
    });
  });

  describe("Device Management", () => {
    it("generateDeviceId() returns 32-char hex string", () => {
      const id = store.generateDeviceId();
      expect(id).toMatch(/^[a-f0-9]{32}$/);
    });

    it("addDevice(device) adds and persists", () => {
      const device: DeviceInfo = {
        id: "dev-123", name: "My Phone", platform: "iOS", browser: "Safari",
        createdAt: Date.now(), lastSeenAt: Date.now(), ip: "1.1.1.1"
      };
      store.addDevice(device);
      
      expect(store.getDevice("dev-123")).toEqual(device);
      
      const fileData = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
      expect(fileData.devices["dev-123"]).toEqual(device);
    });

    it("getDevice(id) returns device or undefined", () => {
      expect(store.getDevice("non-existent")).toBeUndefined();
      
      const device: DeviceInfo = {
        id: "d1", name: "D1", platform: "P1", browser: "B1",
        createdAt: Date.now(), lastSeenAt: Date.now(), ip: "1.1.1.1"
      };
      store.addDevice(device);
      expect(store.getDevice("d1")).toEqual(device);
    });

    it("updateDevice(id, updates) merges updates and persists", () => {
      const device: DeviceInfo = {
        id: "d1", name: "Old Name", platform: "P1", browser: "B1",
        createdAt: 1000, lastSeenAt: 1000, ip: "1.1.1.1"
      };
      store.addDevice(device);
      
      store.updateDevice("d1", { name: "New Name" });
      const updated = store.getDevice("d1");
      expect(updated?.name).toBe("New Name");
      expect(updated?.platform).toBe("P1"); // preserved
      
      const fileData = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
      expect(fileData.devices["d1"].name).toBe("New Name");
    });

    it("updateDevice on non-existent device is a no-op", () => {
      store.updateDevice("none", { name: "Fail" });
      expect(store.getDevice("none")).toBeUndefined();
    });

    it("updateLastSeen(id, ip) updates lastSeenAt and ip", () => {
      const now = 2000;
      vi.setSystemTime(now);
      
      const device: DeviceInfo = {
        id: "d1", name: "D1", platform: "P1", browser: "B1",
        createdAt: 1000, lastSeenAt: 1000, ip: "1.1.1.1"
      };
      store.addDevice(device);
      
      const nextTime = 3000;
      vi.setSystemTime(nextTime);
      store.updateLastSeen("d1", "2.2.2.2");
      
      const updated = store.getDevice("d1");
      expect(updated?.lastSeenAt).toBe(nextTime);
      expect(updated?.ip).toBe("2.2.2.2");
    });

    it("listDevices() returns sorted by lastSeenAt desc", () => {
      store.addDevice({ id: "d1", lastSeenAt: 100, name: "N1", platform: "P1", browser: "B1", createdAt: 0, ip: "" });
      store.addDevice({ id: "d2", lastSeenAt: 300, name: "N2", platform: "P1", browser: "B1", createdAt: 0, ip: "" });
      store.addDevice({ id: "d3", lastSeenAt: 200, name: "N3", platform: "P1", browser: "B1", createdAt: 0, ip: "" });
      
      const list = store.listDevices();
      expect(list.map(d => d.id)).toEqual(["d2", "d3", "d1"]);
    });

    it("removeDevice(id) returns true and removes, false if not found", () => {
      store.addDevice({ id: "d1", name: "N1", platform: "P1", browser: "B1", createdAt: 0, lastSeenAt: 0, ip: "" });
      
      expect(store.removeDevice("d1")).toBe(true);
      expect(store.getDevice("d1")).toBeUndefined();
      expect(store.removeDevice("d1")).toBe(false);
    });
  });

  describe("Token Management", () => {
    it("generateToken(deviceId) returns a JWT string", () => {
      const token = store.generateToken("d1");
      expect(typeof token).toBe("string");
      expect(token.split(".").length).toBe(3);
    });

    it("verifyToken returns valid for valid token of existing device", () => {
      store.addDevice({ id: "d1", name: "N1", platform: "P1", browser: "B1", createdAt: 0, lastSeenAt: 0, ip: "" });
      const token = store.generateToken("d1");
      
      const result = store.verifyToken(token);
      expect(result.valid).toBe(true);
      expect(result.deviceId).toBe("d1");
    });

    it("verifyToken returns invalid for invalid token", () => {
      const result = store.verifyToken("invalid.token.here");
      expect(result.valid).toBe(false);
    });

    it("verifyToken returns invalid for valid JWT but device removed", () => {
      store.addDevice({ id: "d1", name: "N1", platform: "P1", browser: "B1", createdAt: 0, lastSeenAt: 0, ip: "" });
      const token = store.generateToken("d1");
      
      store.removeDevice("d1");
      const result = store.verifyToken(token);
      expect(result.valid).toBe(false);
    });

    it("revokeDevice(deviceId) removes device and token becomes invalid", () => {
      store.addDevice({ id: "d1", name: "N1", platform: "P1", browser: "B1", createdAt: 0, lastSeenAt: 0, ip: "" });
      const token = store.generateToken("d1");
      
      expect(store.revokeDevice("d1")).toBe(true);
      expect(store.verifyToken(token).valid).toBe(false);
    });

    it("revokeAllExcept(keepId) removes all others and returns count", () => {
      store.addDevice({ id: "d1", name: "N1", platform: "P1", browser: "B1", createdAt: 0, lastSeenAt: 0, ip: "" });
      store.addDevice({ id: "d2", name: "N2", platform: "P1", browser: "B1", createdAt: 0, lastSeenAt: 0, ip: "" });
      store.addDevice({ id: "d3", name: "N3", platform: "P1", browser: "B1", createdAt: 0, lastSeenAt: 0, ip: "" });
      
      const count = store.revokeAllExcept("d1");
      expect(count).toBe(2);
      expect(store.getDevice("d1")).toBeDefined();
      expect(store.getDevice("d2")).toBeUndefined();
      expect(store.getDevice("d3")).toBeUndefined();
    });
  });

  describe("Pending Request Management", () => {
    const deviceTemplate = { name: "Phone", platform: "iOS", browser: "Safari" };

    it("createPendingRequest(device, ip) creates with status 'pending'", () => {
      vi.setSystemTime(1000);
      const req = store.createPendingRequest(deviceTemplate, "1.2.3.4");
      
      expect(req.id).toBeDefined();
      expect(req.status).toBe("pending");
      expect(req.createdAt).toBe(1000);
      expect(req.ip).toBe("1.2.3.4");
      expect(req.device).toEqual(deviceTemplate);
      
      expect(store.getPendingRequest(req.id)).toEqual(req);
    });

    it("getPendingRequest returns undefined for non-existent id", () => {
      expect(store.getPendingRequest("none")).toBeUndefined();
    });

    it("getPendingRequest on expired request marks as expired and returns it", () => {
      const req = store.createPendingRequest(deviceTemplate, "1.2.3.4");
      
      // Advance 6 minutes (expiry is 5 min)
      vi.advanceTimersByTime(6 * 60 * 1000);
      
      const result = store.getPendingRequest(req.id);
      expect(result?.status).toBe("expired");
      expect(result?.resolvedAt).toBeDefined();
    });

    it("getPendingRequest on non-existent id returns undefined", () => {
      expect(store.getPendingRequest("none")).toBeUndefined();
    });

    it("listPendingRequests() only returns pending, sorted by createdAt desc", () => {
      vi.setSystemTime(1000);
      store.createPendingRequest(deviceTemplate, "ip1");
      vi.setSystemTime(2000);
      const req2 = store.createPendingRequest(deviceTemplate, "ip2");
      vi.setSystemTime(1500);
      store.createPendingRequest(deviceTemplate, "ip3");
      
      store.denyRequest(req2.id); // req2 is no longer pending
      
      const list = store.listPendingRequests();
      expect(list).toHaveLength(2);
      expect(list[0].ip).toBe("ip3"); // 1500
      expect(list[1].ip).toBe("ip1"); // 1000
    });

    it("approveRequest(id) approves and creates device + token", () => {
      const req = store.createPendingRequest(deviceTemplate, "1.2.3.4");
      
      vi.setSystemTime(2000);
      const approved = store.approveRequest(req.id);
      
      expect(approved?.status).toBe("approved");
      expect(approved?.resolvedAt).toBe(2000);
      expect(approved?.deviceId).toBeDefined();
      expect(approved?.token).toBeDefined();
      
      const device = store.getDevice(approved!.deviceId!);
      expect(device?.name).toBe(deviceTemplate.name);
      expect(device?.ip).toBe("1.2.3.4");
      
      // Verify token works
      expect(store.verifyToken(approved!.token!).valid).toBe(true);
    });

    it("approveRequest on already approved returns undefined", () => {
      const req = store.createPendingRequest(deviceTemplate, "ip");
      store.approveRequest(req.id);
      expect(store.approveRequest(req.id)).toBeUndefined();
    });

    it("approveRequest on expired returns undefined", () => {
      const req = store.createPendingRequest(deviceTemplate, "ip");
      vi.advanceTimersByTime(6 * 60 * 1000);
      expect(store.approveRequest(req.id)).toBeUndefined();
    });

    it("denyRequest(id) updates status to denied", () => {
      const req = store.createPendingRequest(deviceTemplate, "ip");
      const denied = store.denyRequest(req.id);
      
      expect(denied?.status).toBe("denied");
      expect(denied?.resolvedAt).toBeDefined();
      expect(store.getPendingRequest(req.id)?.status).toBe("denied");
    });

    it("denyRequest returns undefined for non-pending", () => {
      const req = store.createPendingRequest(deviceTemplate, "ip");
      store.denyRequest(req.id);
      expect(store.denyRequest(req.id)).toBeUndefined();
    });

    it("cleanupExpiredRequests removes resolved requests after 24 hours", () => {
      const req = store.createPendingRequest(deviceTemplate, "ip");
      store.denyRequest(req.id);
      
      // Advance 25 hours
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
      
      // cleanup happens during listPendingRequests or createPendingRequest
      store.listPendingRequests();
      
      // Should be gone from store data
      expect(store.getPendingRequest(req.id)).toBeUndefined();
    });
  });

  describe("Access Code", () => {
    it("getAccessCode() returns 6-digit string", () => {
      const code = store.getAccessCode();
      expect(code).toMatch(/^\d{6}$/);
    });

    it("getAccessCode() is deterministic", () => {
      const code1 = store.getAccessCode();
      const code2 = store.getAccessCode();
      expect(code1).toBe(code2);
      
      // New store with same secret should have same code
      const secret = store.testGetData().jwtSecret;
      const dbPath2 = path.join(tmpDir, "devices2.json");
      fs.writeFileSync(dbPath2, JSON.stringify({
        devices: {}, pendingRequests: {}, jwtSecret: secret
      }));
      const store2 = new TestDeviceStore(dbPath2);
      expect(store2.getAccessCode()).toBe(code1);
    });
  });

  describe("Hooks & Edge Cases", () => {
    it("beforeRead() is called before major read operations", () => {
      store.getDevice("any");
      store.listDevices();
      store.addDevice({ id: "d", name: "n", platform: "p", browser: "b", createdAt: 0, lastSeenAt: 0, ip: "" });
      
      // Initial load in constructor doesn't call beforeRead in our implementation 
      // because loadData calls loadFromDisk directly.
      // But getDevice, listDevices, addDevice do call it.
      expect(store.getBeforeReadCount()).toBeGreaterThanOrEqual(3);
    });
  });
});
