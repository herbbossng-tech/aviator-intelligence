import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/env.js';

const ROOT = path.resolve('/tmp/aviator-repo-root');

describe('loadConfig', () => {
  it('applies safe defaults when nothing is set', () => {
    const config = loadConfig({}, ROOT);
    expect(config).toEqual({
      nodeEnv: 'development',
      host: '127.0.0.1',
      port: 4317,
      dbPath: path.join(ROOT, 'data/aviator.sqlite'),
      currency: 'NGN',
    });
  });

  it('treats blank values as unset', () => {
    expect(loadConfig({ API_PORT: '  ', API_HOST: '' }, ROOT).port).toBe(4317);
  });

  it('resolves relative database paths against the repository root and keeps :memory:', () => {
    expect(loadConfig({ AVIATOR_DB_PATH: 'tmp/x.sqlite' }, ROOT).dbPath).toBe(
      path.join(ROOT, 'tmp/x.sqlite'),
    );
    expect(loadConfig({ AVIATOR_DB_PATH: ':memory:' }, ROOT).dbPath).toBe(':memory:');
  });

  it.each([
    [{ API_PORT: 'abc' }, 'API_PORT'],
    [{ API_PORT: '70000' }, 'API_PORT'],
    [{ NODE_ENV: 'staging' }, 'NODE_ENV'],
    [{ AVIATOR_CURRENCY: 'BTC' }, 'AVIATOR_CURRENCY'],
    [{ AVIATOR_ALLOW_REMOTE_BIND: 'yes' }, 'AVIATOR_ALLOW_REMOTE_BIND'],
  ])('rejects invalid %j with a message naming the variable', (env, variable) => {
    expect(() => loadConfig(env, ROOT)).toThrow(ConfigError);
    expect(() => loadConfig(env, ROOT)).toThrow(variable);
  });

  it('refuses non-loopback hosts unless explicitly allowed', () => {
    expect(() => loadConfig({ API_HOST: '0.0.0.0' }, ROOT)).toThrow(/non-loopback/);
    expect(loadConfig({ API_HOST: '0.0.0.0', AVIATOR_ALLOW_REMOTE_BIND: 'true' }, ROOT).host).toBe(
      '0.0.0.0',
    );
    expect(loadConfig({ API_HOST: 'localhost' }, ROOT).host).toBe('localhost');
  });

  it('does not echo variable values in error messages', () => {
    try {
      loadConfig({ AVIATOR_CURRENCY: 'SECRET-LOOKING-VALUE' }, ROOT);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('SECRET-LOOKING-VALUE');
    }
  });
});
