import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/connection.js';
import { createApp } from '../src/http/app.js';
import { hostnameOf } from '../src/http/hostGuard.js';
import { createTestDb, TEST_CONFIG } from './helpers.js';

// Regression for DNS rebinding: a page on another domain re-pointed at 127.0.0.1 sends its own
// Host header. fetch() cannot set Host, so these requests use node:http directly.

const open: { db: Db; server: http.Server }[] = [];
afterEach(async () => {
  for (const { db, server } of open.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

async function start(host = TEST_CONFIG.host) {
  const db = createTestDb();
  const app = createApp({ db, config: { ...TEST_CONFIG, host }, log: () => {} });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  open.push({ db, server });
  return { db, port: (server.address() as AddressInfo).port };
}

function send(
  port: number,
  hostHeader: string | null,
  method = 'GET',
  path = '/api/overview',
  body?: unknown,
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        // null: send no Host header at all.
        setHost: hostHeader !== null,
        headers: {
          ...(hostHeader !== null ? { Host: hostHeader } : {}),
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('loopback Host guard', () => {
  it.each([
    'attacker.example',
    'attacker.example:4317',
    '127.0.0.1.attacker.example',
    '0.0.0.0',
    '192.168.1.5:4317',
    '127.0.0.2:4317',
    'localhost.',
    // Malformed authorities must not be reduced to a loopback-looking prefix.
    '[::1]evil.example',
    '[::1]evil.example:80',
    'localhost:4317:9999',
    'localhost:abc',
    'localhost@evil.example',
    'localhost:99999',
  ])('rejects reads and writes addressed to %j and stores nothing', async (hostHeader) => {
    const { db, port } = await start();
    const read = await send(port, hostHeader);
    expect(read.status).toBe(403);
    expect(JSON.parse(read.body).error.code).toBe('forbidden_host');
    const write = await send(port, hostHeader, 'POST', '/api/rounds', {
      source: 'rebind',
      multiplier: '2',
    });
    expect(write.status).toBe(403);
    expect((db.prepare('SELECT COUNT(*) AS n FROM rounds').get() as { n: number }).n).toBe(0);
    const simulate = await send(port, hostHeader, 'POST', '/api/simulations', {});
    expect(simulate.status).toBe(403);
    const analyse = await send(port, hostHeader, 'POST', '/api/simulations/1/analyses', {
      paths: 10,
      seed: 1,
    });
    expect(analyse.status).toBe(403);
    expect((db.prepare('SELECT COUNT(*) AS n FROM simulation_runs').get() as { n: number }).n).toBe(
      0,
    );
  });

  it.each(['127.0.0.1', '127.0.0.1:4317', 'localhost:5173', 'LOCALHOST:5173', '[::1]:4317'])(
    'accepts loopback host %j',
    async (hostHeader) => {
      const { port } = await start();
      expect((await send(port, hostHeader)).status).toBe(200);
    },
  );

  it('refuses requests with no Host header (rejected by Node before reaching the app)', async () => {
    const { db, port } = await start();
    expect((await send(port, null)).status).toBe(400);
    expect(
      (await send(port, null, 'POST', '/api/rounds', { source: 's', multiplier: '2' })).status,
    ).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS n FROM rounds').get() as { n: number }).n).toBe(0);
  });

  it('is not applied when the operator explicitly binds to a non-loopback address', async () => {
    const { port } = await start('0.0.0.0');
    expect((await send(port, 'my-lan-hostname:4317')).status).toBe(200);
  });

  it('parses host header values', () => {
    expect(hostnameOf('127.0.0.1:4317')).toBe('127.0.0.1');
    expect(hostnameOf('[::1]:4317')).toBe('::1');
    expect(hostnameOf('LocalHost')).toBe('localhost');
    expect(hostnameOf(undefined)).toBeNull();
    expect(hostnameOf('[::1')).toBeNull();
    expect(hostnameOf('[::1]evil.example')).toBeNull();
    expect(hostnameOf('localhost:4317:9999')).toBeNull();
    expect(hostnameOf('localhost:')).toBeNull();
    expect(hostnameOf('localhost:99999')).toBeNull();
    expect(hostnameOf(' localhost')).toBeNull();
    expect(hostnameOf('127.0.0.1.attacker.example')).toBe('127.0.0.1.attacker.example');
  });
});
