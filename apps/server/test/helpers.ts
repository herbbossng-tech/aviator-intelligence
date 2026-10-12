import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { AppConfig } from '../src/config/env.js';
import { openDatabase, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';

export const TEST_CONFIG: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  dbPath: ':memory:',
  currency: 'NGN',
};

export function createTestDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

/** SYNTHETIC TEST FIXTURE: not real Aviator data. Always flagged is_synthetic = 1 unless overridden. */
export const SYNTHETIC_SOURCE = 'synthetic-test-fixture';

export async function startTestServer(db: Db, log: (m: string, e: unknown) => void = () => {}) {
  const app = createApp({ db, config: TEST_CONFIG, log });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
