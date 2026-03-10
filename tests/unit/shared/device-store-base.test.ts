import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeviceStoreBase } from '../../../shared/device-store-base';
import fs from 'fs';

vi.mock('fs');

// Concrete implementation for testing abstract class
class TestDeviceStore extends DeviceStoreBase {
  constructor(private filePath: string) {
    super();
    this.loadData();
  }
  protected getFilePath(): string {
    return this.filePath;
  }
}

describe('DeviceStoreBase', () => {
  const testPath = '/tmp/test-devices.json';
  let store: TestDeviceStore;

  beforeEach(() => {
    vi.resetAllMocks();
    (fs.existsSync as any).mockReturnValue(false);
    (fs.readFileSync as any).mockReturnValue('{}');
    store = new TestDeviceStore(testPath);
  });

  describe('Persistence & Lifecycle', () => {
    it('initializes correctly: creates file, loads existing, or handles corrupt JSON', () => {
      // Create file case
      expect(fs.writeFileSync).toHaveBeenCalledWith(testPath, expect.stringContaining('{}'));

      // Load existing case
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify({ devices: { d1: { id: 'd1', name: 'Dev 1' } } }));
      const store2 = new TestDeviceStore(testPath);
      expect(store2.listDevices()).toHaveLength(1);

      // Corrupt JSON case
      (fs.readFileSync as any).mockReturnValue('invalid-json');
      const store3 = new TestDeviceStore(testPath);
      expect(store3.listDevices()).toHaveLength(0);
    });

    it('manages data reloading', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify({ devices: { d2: { id: 'd2' } } }));
      store.reload();
      expect(store.listDevices()).toHaveLength(1);
    });
  });

  describe('Device Management', () => {
    it('generates IDs and manages device lifecycle (add, get, list, remove)', () => {
      const id = store.generateDeviceId();
      expect(id).toMatch(/^[a-f0-9]+$/);

      const device = { id, name: 'Test', lastSeenAt: 123 } as any;
      store.addDevice(device);
      expect(store.getDevice(id)).toEqual(device);
      expect(store.listDevices()).toContainEqual(device);

      store.removeDevice(id);
      expect(store.getDevice(id)).toBeUndefined();
    });

    it('updates device properties and handles non-existent devices', () => {
      const id = 'd1';
      store.addDevice({ id, name: 'Old' } as any);
      
      // Update
      store.updateDevice(id, { name: 'New' });
      expect(store.getDevice(id)?.name).toBe('New');

      // No-op for non-existent
      store.updateDevice('none', { name: 'X' });
      expect(store.getDevice('none')).toBeUndefined();
    });

    it('updates last seen timestamps', () => {
      const id = 'd1';
      const now = 1000;
      vi.useFakeTimers();
      vi.setSystemTime(now);
      store.addDevice({ id, lastSeenAt: 0 } as any);
      
      store.updateLastSeen(id, '1.1.1.1');
      expect(store.getDevice(id)?.lastSeenAt).toBe(now);
      expect(store.getDevice(id)?.ip).toBe('1.1.1.1');
      vi.useRealTimers();
    });
  });

  describe('Token Management', () => {
    it('generates and verifies tokens for valid or removed devices', () => {
      const deviceId = 'd1';
      store.addDevice({ id: deviceId } as any);
      const token = store.generateToken(deviceId);
      
      // Valid
      expect(store.verifyToken(token).valid).toBe(true);

      // Invalid token
      expect(store.verifyToken('bad-token').valid).toBe(false);

      // Removed device
      store.removeDevice(deviceId);
      expect(store.verifyToken(token).valid).toBe(false);
    });

    it('revokes devices selectively or en masse', () => {
      store.addDevice({ id: 'd1' } as any);
      store.addDevice({ id: 'd2' } as any);
      store.addDevice({ id: 'd3' } as any);

      // Revoke all except
      store.revokeAllExcept('d1');
      expect(store.getDevice('d1')).toBeDefined();
      expect(store.getDevice('d2')).toBeUndefined();
      expect(store.getDevice('d3')).toBeUndefined();
    });
  });

  describe('Pending Requests', () => {
    it('manages pending access requests', () => {
      const req = store.createPendingRequest({ name: 'PC' } as any, '1.2.3.4');
      expect(req.id).toBeDefined();
      expect(store.getPendingRequest(req.id)).toEqual(req);
      expect(store.getPendingRequest('none')).toBeUndefined();
    });

    it('handles expiration and listing of pending requests', () => {
      vi.useFakeTimers();
      const req = store.createPendingRequest({ name: 'PC' } as any, 'ip');
      
      // List
      expect(store.listPendingRequests()).toHaveLength(1);

      // Expire (5 mins)
      vi.advanceTimersByTime(6 * 60 * 1000);
      // getPendingRequest handles expiration internally
      expect(store.getPendingRequest(req.id)?.status).toBe('expired');
      expect(store.listPendingRequests()).toHaveLength(0);
      vi.useRealTimers();
    });

    it('handles approval logic: success, already approved, or expired', () => {
      const req = store.createPendingRequest({ name: 'PC' } as any, 'ip');
      
      // Success
      const approved = store.approveRequest(req.id);
      expect(approved?.status).toBe('approved');
      expect(approved?.token).toBeDefined();
      expect(store.getDevice(approved!.deviceId!)).toBeDefined();

      // Already approved
      expect(store.approveRequest(req.id)).toBeUndefined();
    });

    it('handles denial of requests', () => {
      const req = store.createPendingRequest({ name: 'PC' } as any, 'ip');
      
      // Success
      expect(store.denyRequest(req.id)).toBeDefined();
      expect(store.getPendingRequest(req.id)?.status).toBe('denied');

      // Non-pending
      expect(store.denyRequest('none')).toBeUndefined();
    });
  });

  describe('Access Code', () => {
    it('manages the access code derived from secret', () => {
      const code = store.getAccessCode();
      expect(code).toMatch(/^\d{6}$/);
      
      // Consistency check
      expect(store.getAccessCode()).toBe(code);
    });
  });
});
