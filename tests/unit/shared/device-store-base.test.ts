import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  public cleanupExpiredRequestsPublic(): void {
    this.cleanupExpiredRequests();
  }
  public cleanupInactiveDevicesPublic(): void {
    this.cleanupInactiveDevices();
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
      expect(fs.writeFileSync).toHaveBeenCalledWith(testPath, expect.stringContaining('{}'), { mode: 0o600 });

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

      const device = { id, name: 'Test', lastSeenAt: Date.now() } as any;
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

    it('handles approveRequest edge cases: expired or non-existent', () => {
      vi.useFakeTimers();
      const req = store.createPendingRequest({ name: 'PC' } as any, 'ip');
      
      // Non-existent
      expect(store.approveRequest('none')).toBeUndefined();

      // Expired
      vi.advanceTimersByTime(6 * 60 * 1000);
      expect(store.approveRequest(req.id)).toBeUndefined();
      expect(store.getPendingRequest(req.id)?.status).toBe('expired');
      vi.useRealTimers();
    });
  });

  describe('Additional Edge Cases & Maintenance', () => {
    it('cleans up expired requests after 24-hour retention', () => {
      vi.useFakeTimers();
      const req1 = store.createPendingRequest({ name: 'Old' } as any, 'ip');
      
      // Resolve req1 (approve) and let it age
      store.approveRequest(req1.id);
      
      // Age 25 hours
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
      
      // Statuses: 
      // req1: approved (25h ago)
      
      // req2: created now, will be fresh
      const req2 = store.createPendingRequest({ name: 'Recent' } as any, 'ip');
      store.denyRequest(req2.id);
      
      store.cleanupExpiredRequestsPublic();
      
      expect(store.getPendingRequest(req1.id)).toBeUndefined(); // Removed (>24h)
      expect(store.getPendingRequest(req2.id)).toBeDefined();   // Kept (<24h)
      vi.useRealTimers();
    });

    it('handles revokeAllExcept edge cases', () => {
      // Empty store
      expect(store.revokeAllExcept('none')).toBe(0);

      // Only kept device exists
      store.addDevice({ id: 'd1' } as any);
      expect(store.revokeAllExcept('d1')).toBe(0);
      expect(store.getDevice('d1')).toBeDefined();
    });

    it('sorts devices by lastSeenAt descending', () => {
      const now = Date.now();
      store.addDevice({ id: 'd1', lastSeenAt: now - 2000 } as any);
      store.addDevice({ id: 'd2', lastSeenAt: now } as any);
      store.addDevice({ id: 'd3', lastSeenAt: now - 1000 } as any);

      const sorted = store.listDevices();
      expect(sorted.map(d => d.id)).toEqual(['d2', 'd3', 'd1']);
    });
  });

  describe('Inactive Device Auto-Cleanup', () => {
    const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;

    afterEach(() => {
      vi.useRealTimers();
    });

    it('removes non-host devices inactive for more than 14 days', () => {
      vi.useFakeTimers();
      const now = Date.now();

      store.addDevice({ id: 'd1', lastSeenAt: now - FOURTEEN_DAYS - 1, isHost: false } as any);
      store.addDevice({ id: 'd2', lastSeenAt: now - FOURTEEN_DAYS + 60000, isHost: false } as any);

      store.cleanupInactiveDevicesPublic();

      expect(store.getDevice('d1')).toBeUndefined();
      expect(store.getDevice('d2')).toBeDefined();
    });

    it('never removes host devices regardless of inactivity', () => {
      vi.useFakeTimers();
      const now = Date.now();

      store.addDevice({ id: 'host', lastSeenAt: now - FOURTEEN_DAYS - 1, isHost: true } as any);
      store.addDevice({ id: 'remote', lastSeenAt: now - FOURTEEN_DAYS - 1, isHost: false } as any);

      store.cleanupInactiveDevicesPublic();

      expect(store.getDevice('host')).toBeDefined();
      expect(store.getDevice('remote')).toBeUndefined();
    });

    it('triggers cleanup when listing devices', () => {
      vi.useFakeTimers();
      const now = Date.now();

      store.addDevice({ id: 'stale', lastSeenAt: now - FOURTEEN_DAYS - 1 } as any);
      store.addDevice({ id: 'active', lastSeenAt: now } as any);

      const devices = store.listDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].id).toBe('active');
    });

    it('triggers cleanup via cleanupExpiredRequests', () => {
      vi.useFakeTimers();
      const now = Date.now();

      store.addDevice({ id: 'stale', lastSeenAt: now - FOURTEEN_DAYS - 1 } as any);
      store.cleanupExpiredRequestsPublic();

      expect(store.getDevice('stale')).toBeUndefined();
    });

    it('invalidates tokens for cleaned-up devices via verifyToken', () => {
      vi.useFakeTimers();
      const now = Date.now();

      store.addDevice({ id: 'd1', lastSeenAt: now } as any);
      const token = store.generateToken('d1');
      expect(store.verifyToken(token).valid).toBe(true);

      // Simulate 15 days of inactivity
      vi.advanceTimersByTime(FOURTEEN_DAYS + 1);
      expect(store.verifyToken(token).valid).toBe(false);
      expect(store.getDevice('d1')).toBeUndefined();
    });
  });

  describe('Access Code', () => {
    it('manages the access code derived from secret', () => {
      const code = store.getAccessCode();
      expect(code).toMatch(/^\d{6}$/);
      
      // Consistency check
      expect(store.getAccessCode()).toBe(code);
      
      // Always 6 digits
      for (let i = 0; i < 5; i++) {
        expect(store.getAccessCode()).toMatch(/^\d{6}$/);
      }
    });
  });
});
