import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { currencyCodeSchema, type CurrencyCode } from '@aviator/shared';

/** Repository root: apps/server/{src,dist}/config -> four levels up. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const DEFAULT_DB_PATH = 'data/aviator.sqlite';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const booleanFlag = z
  .enum(['true', 'false'], { message: 'must be "true" or "false"' })
  .default('false')
  .transform((v) => v === 'true');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().trim().min(1).default('127.0.0.1'),
    API_PORT: z.coerce
      .number({ message: 'must be a number' })
      .int()
      .min(1, 'must be between 1 and 65535')
      .max(65_535, 'must be between 1 and 65535')
      .default(4317),
    AVIATOR_ALLOW_REMOTE_BIND: booleanFlag,
    AVIATOR_DB_PATH: z.string().trim().min(1).default(DEFAULT_DB_PATH),
    AVIATOR_CURRENCY: currencyCodeSchema.default('NGN'),
  })
  .refine((env) => env.AVIATOR_ALLOW_REMOTE_BIND || LOOPBACK_HOSTS.has(env.API_HOST), {
    message:
      'refusing to bind to a non-loopback address; use 127.0.0.1/localhost, or set AVIATOR_ALLOW_REMOTE_BIND=true if you understand the exposure',
    path: ['API_HOST'],
  });

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  /** Absolute path, or the literal ':memory:'. */
  dbPath: string;
  currency: CurrencyCode;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates configuration from an environment object. Only the keys above are read,
 * and error messages name variables but never echo their values.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  repoRoot = REPO_ROOT,
): AppConfig {
  const pick = (key: string) => {
    const value = env[key];
    return value === undefined || value.trim() === '' ? undefined : value;
  };
  const result = envSchema.safeParse({
    NODE_ENV: pick('NODE_ENV'),
    API_HOST: pick('API_HOST'),
    API_PORT: pick('API_PORT'),
    AVIATOR_ALLOW_REMOTE_BIND: pick('AVIATOR_ALLOW_REMOTE_BIND'),
    AVIATOR_DB_PATH: pick('AVIATOR_DB_PATH'),
    AVIATOR_CURRENCY: pick('AVIATOR_CURRENCY'),
  });
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const parsed = result.data;
  const dbPath =
    parsed.AVIATOR_DB_PATH === ':memory:'
      ? ':memory:'
      : path.resolve(repoRoot, parsed.AVIATOR_DB_PATH);
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.API_HOST,
    port: parsed.API_PORT,
    dbPath,
    currency: parsed.AVIATOR_CURRENCY,
  };
}

/** Loads `<repo>/.env` into process.env if present (existing variables win). */
export function loadDotEnvFile(repoRoot = REPO_ROOT): void {
  const file = path.join(repoRoot, '.env');
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}
