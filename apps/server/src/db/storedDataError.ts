/**
 * A row already in the database could not be read back into its API shape (for example a
 * row written outside the app, or by an older version). This is a server-side data
 * problem, never a client validation error. The row is left untouched; the underlying
 * cause is kept for the server log and is not sent to the client.
 */
export class StoredDataError extends Error {
  constructor(
    readonly record: { simulationRunId: number },
    cause: unknown,
  ) {
    super(`Stored simulation run ${record.simulationRunId} could not be read`, { cause });
    this.name = 'StoredDataError';
  }
}
