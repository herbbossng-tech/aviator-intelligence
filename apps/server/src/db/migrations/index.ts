import { sql as initialSchema } from './001_initial_schema.js';
import { sql as roundImports } from './002_round_imports.js';
import { sql as simulationBacktests } from './003_simulation_backtests.js';
import { sql as simulationAnalyses } from './004_simulation_analyses.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered, append-only list. Never edit a migration once it has been applied anywhere; add a new one. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial_schema', sql: initialSchema },
  { version: 2, name: 'round_imports', sql: roundImports },
  { version: 3, name: 'simulation_backtests', sql: simulationBacktests },
  { version: 4, name: 'simulation_analyses', sql: simulationAnalyses },
];
