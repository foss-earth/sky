/** Attempts every owned release and preserves all failures, including nested cleanup failures. */
export function cleanupAll(message: string, releases: readonly (() => void)[]): void {
  const failures: unknown[] = [];
  for (const release of releases) {
    try {
      release();
    } catch (error) {
      if (error instanceof AggregateError) failures.push(...error.errors);
      else failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, message);
}
