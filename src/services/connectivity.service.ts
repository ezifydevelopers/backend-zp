/**
 * Connectivity Service - Detects online/offline status
 * Uses multiple methods for reliable detection
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export enum ConnectivityStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  CHECKING = 'checking',
  UNKNOWN = 'unknown'
}

interface ConnectivityCheckOptions {
  timeout?: number;
  retries?: number;
  checkInterval?: number;
}

class ConnectivityService {
  private status: ConnectivityStatus = ConnectivityStatus.UNKNOWN;
  private lastCheck: Date | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private listeners: Array<(status: ConnectivityStatus) => void> = [];

  // Health check endpoints to try
  private healthCheckUrls: string[] = [
    'https://www.google.com',
    'https://www.cloudflare.com',
    'https://1.1.1.1',
    'http://localhost:5432', // PostgreSQL default port
  ];

  constructor() {
    // Initial check
    this.checkConnectivity();

    // Periodic checks every 30 seconds
    this.startPeriodicCheck(30000);
  }

  /**
   * Check connectivity using multiple methods
   */
  async checkConnectivity(options: ConnectivityCheckOptions = {}): Promise<ConnectivityStatus> {
    const {
      timeout = 5000,
      retries = 2
    } = options;

    this.status = ConnectivityStatus.CHECKING;

    // Method 1: Check PostgreSQL connection (primary indicator)
    const postgresAvailable = await this.checkPostgreSQLConnection(timeout);

    if (postgresAvailable) {
      this.setStatus(ConnectivityStatus.ONLINE);
      return ConnectivityStatus.ONLINE;
    }

    // Method 2: Check internet connectivity (secondary indicator)
    const internetAvailable = await this.checkInternetConnectivity(timeout, retries);

    if (internetAvailable) {
      // Internet is available but PostgreSQL might not be
      // Still mark as online if internet is available
      this.setStatus(ConnectivityStatus.ONLINE);
      return ConnectivityStatus.ONLINE;
    }

    // Method 3: Check network interfaces
    const networkAvailable = this.checkNetworkInterfaces();

    if (!networkAvailable) {
      this.setStatus(ConnectivityStatus.OFFLINE);
      return ConnectivityStatus.OFFLINE;
    }

    // If network is available but no internet/PostgreSQL, still offline
    this.setStatus(ConnectivityStatus.OFFLINE);
    return ConnectivityStatus.OFFLINE;
  }

  /**
   * Check PostgreSQL connection
   */
  private async checkPostgreSQLConnection(timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      const postgresUrl = process.env.REMOTE_DATABASE_URL ||
                         process.env.POSTGRESQL_URL ||
                         process.env.DATABASE_URL;

      if (!postgresUrl || !postgresUrl.startsWith('postgresql://')) {
        resolve(false);
        return;
      }

      try {
        const { Client } = require('pg');
        const client = new Client({
          connectionString: postgresUrl,
          connectionTimeoutMillis: timeout
        });

        const connectPromise = client.connect();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), timeout)
        );

        Promise.race([connectPromise, timeoutPromise])
          .then(() => {
            client.query('SELECT 1')
              .then(() => {
                client.end();
                resolve(true);
              })
              .catch(() => {
                client.end().catch(() => {});
                resolve(false);
              });
          })
          .catch(() => {
            resolve(false);
          });
      } catch (error) {
        resolve(false);
      }
    });
  }

  /**
   * Check internet connectivity
   */
  private async checkInternetConnectivity(timeout: number, retries: number): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      for (const url of this.healthCheckUrls) {
        try {
          const isAvailable = await this.pingUrl(url, timeout);
          if (isAvailable) {
            return true;
          }
        } catch (error) {
          // Continue to next URL
        }
      }
    }
    return false;
  }

  /**
   * Ping a URL with timeout
   */
  private async pingUrl(urlString: string, timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const url = new URL(urlString);
        const client = url.protocol === 'https:' ? https : http;

        const request = client.get(urlString, { timeout }, (response) => {
          resolve(response.statusCode !== undefined && response.statusCode < 500);
        });

        request.on('timeout', () => {
          request.destroy();
          resolve(false);
        });

        request.on('error', () => {
          resolve(false);
        });
      } catch (error) {
        resolve(false);
      }
    });
  }

  /**
   * Check network interfaces
   */
  private checkNetworkInterfaces(): boolean {
    try {
      const os = require('os');
      const interfaces = os.networkInterfaces();

      for (const name of Object.keys(interfaces)) {
        const addresses = interfaces[name];
        if (addresses) {
          for (const addr of addresses) {
            // Check if interface is up and not internal
            if (!addr.internal && addr.family === 'IPv4') {
              return true;
            }
          }
        }
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Set status and notify listeners
   */
  private setStatus(newStatus: ConnectivityStatus): void {
    if (this.status !== newStatus) {
      const previousStatus = this.status;
      this.status = newStatus;
      this.lastCheck = new Date();

      // Notify listeners
      this.listeners.forEach(listener => {
        try {
          listener(newStatus);
        } catch (error) {
          console.error('[Connectivity] Listener error:', error);
        }
      });

      console.log(`[Connectivity] Status changed: ${previousStatus} → ${newStatus}`);
    }
  }

  /**
   * Start periodic connectivity checks
   */
  startPeriodicCheck(intervalMs: number): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(() => {
      this.checkConnectivity();
    }, intervalMs);

    console.log(`[Connectivity] Started periodic checks every ${intervalMs}ms`);
  }

  /**
   * Stop periodic checks
   */
  stopPeriodicCheck(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Get current status
   */
  getStatus(): ConnectivityStatus {
    return this.status;
  }

  /**
   * Check if online
   */
  isOnline(): boolean {
    return this.status === ConnectivityStatus.ONLINE;
  }

  /**
   * Check if offline
   */
  isOffline(): boolean {
    return this.status === ConnectivityStatus.OFFLINE;
  }

  /**
   * Add status change listener
   */
  onStatusChange(listener: (status: ConnectivityStatus) => void): () => void {
    this.listeners.push(listener);

    // Return unsubscribe function
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Get last check time
   */
  getLastCheck(): Date | null {
    return this.lastCheck;
  }
}

// Singleton instance
let connectivityServiceInstance: ConnectivityService | null = null;

export function getConnectivityService(): ConnectivityService {
  if (!connectivityServiceInstance) {
    connectivityServiceInstance = new ConnectivityService();
  }
  return connectivityServiceInstance;
}
