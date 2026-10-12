import { sql as initialSchema } from './001_initial_schema.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered, append-only list. Never edit a migration once it has been applied anywhere; add a new one. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial_schema', sql: initialSchema },
];
