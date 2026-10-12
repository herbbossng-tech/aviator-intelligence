import { ConfigError, loadConfig, loadDotEnvFile } from '../config/env.js';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';

try {
  loadDotEnvFile();
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  try {
    const { applied, currentVersion } = migrate(db);
    console.log(
      applied.length > 0
        ? `Applied migrations ${applied.join(', ')}; schema version is now ${currentVersion}.`
        : `Database already up to date (schema version ${currentVersion}).`,
    );
    console.log(`Database: ${config.dbPath}`);
  } finally {
    db.close();
  }
} catch (error) {
  console.error(
    error instanceof ConfigError ? error.message : `Migration failed: ${String(error)}`,
  );
  process.exit(1);
}
