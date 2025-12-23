/**
 * Connectivity Service Tests
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { getConnectivityService, ConnectivityStatus } from '../src/services/connectivity.service';

describe('Connectivity Service', () => {
  let connectivityService: any;

  beforeEach(() => {
    connectivityService = getConnectivityService();
  });

  describe('Status Detection', () => {
    it('should have initial status', () => {
      const status = connectivityService.getStatus();
      expect([ConnectivityStatus.ONLINE, ConnectivityStatus.OFFLINE, ConnectivityStatus.CHECKING, ConnectivityStatus.UNKNOWN]).toContain(status);
    });

    it('should check connectivity', async () => {
      const status = await connectivityService.checkConnectivity();
      expect([ConnectivityStatus.ONLINE, ConnectivityStatus.OFFLINE]).toContain(status);
    });

    it('should detect online status', () => {
      // Mock online status
      connectivityService['status'] = ConnectivityStatus.ONLINE;
      expect(connectivityService.isOnline()).toBe(true);
      expect(connectivityService.isOffline()).toBe(false);
    });

    it('should detect offline status', () => {
      // Mock offline status
      connectivityService['status'] = ConnectivityStatus.OFFLINE;
      expect(connectivityService.isOffline()).toBe(true);
      expect(connectivityService.isOnline()).toBe(false);
    });
  });

  describe('Status Change Listeners', () => {
    it('should notify listeners on status change', () => {
      const listener = jest.fn();
      const unsubscribe = connectivityService.onStatusChange(listener);

      // Simulate status change
      connectivityService['setStatus'](ConnectivityStatus.ONLINE);

      expect(listener).toHaveBeenCalledWith(ConnectivityStatus.ONLINE);

      unsubscribe();
    });

    it('should allow unsubscribing from status changes', () => {
      const listener = jest.fn();
      const unsubscribe = connectivityService.onStatusChange(listener);

      unsubscribe();

      // Simulate status change
      connectivityService['setStatus'](ConnectivityStatus.OFFLINE);

      // Listener should not be called after unsubscribe
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('Periodic Checks', () => {
    it('should start periodic checks', () => {
      connectivityService.startPeriodicCheck(1000);
      expect(connectivityService['checkInterval']).toBeDefined();

      connectivityService.stopPeriodicCheck();
    });

    it('should stop periodic checks', () => {
      connectivityService.startPeriodicCheck(1000);
      connectivityService.stopPeriodicCheck();

      expect(connectivityService['checkInterval']).toBeNull();
    });
  });
});
