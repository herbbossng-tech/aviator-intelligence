import { ConfigError, loadConfig, loadDotEnvFile } from './config/env.js';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createApp } from './http/app.js';

function main(): void {
  loadDotEnvFile();
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const { applied, currentVersion } = migrate(db);
  if (applied.length > 0) {
    console.log(`Applied database migrations: ${applied.join(', ')}`);
  }
  console.log(`Database ready (schema version ${currentVersion}) at ${config.dbPath}`);

  const app = createApp({ db, config });
  const server = app.listen(config.port, config.host, () => {
    console.log(
      `Aviator Intelligence API listening on http://${config.host}:${config.port} (research/simulation mode)`,
    );
  });
  server.on('error', (error) => {
    console.error('API server failed to start:', error.message);
    db.close();
    process.exit(1);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    console.error('See .env.example for the supported variables and defaults.');
  } else {
    console.error('Startup failed:', error instanceof Error ? error.message : error);
  }
  process.exit(1);
}
