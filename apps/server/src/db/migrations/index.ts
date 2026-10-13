import { sql as initialSchema } from './001_initial_schema.js';
import { sql as roundImports } from './002_round_imports.js';
import { sql as simulationBacktests } from './003_simulation_backtests.js';
import { sql as simulationAnalyses } from './004_simulation_analyses.js';
import { sql as robustnessAnalyses } from './005_robustness_analyses.js';
import { sql as backtestProgressions } from './006_backtest_progressions.js';
import { sql as blockBootstrapAnalyses } from './007_block_bootstrap_analyses.js';

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
  { version: 5, name: 'robustness_analyses', sql: robustnessAnalyses },
  { version: 6, name: 'backtest_progressions', sql: backtestProgressions },
  { version: 7, name: 'block_bootstrap_analyses', sql: blockBootstrapAnalyses },
];
