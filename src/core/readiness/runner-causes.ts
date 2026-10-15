import { CLI_TOOL_CATALOG } from '../runners/cli-tool-catalog.js';
import type { ReadinessCheck, RunnerReadinessCause } from './types.js';

export function runnerCauseKey(cause: RunnerReadinessCause): string {
  return JSON.stringify([cause.tool, cause.authChannel ?? null, cause.cause]);
}

export function sameRunnerCause(left: RunnerReadinessCause, right: RunnerReadinessCause): boolean {
  return (
    runnerCauseKey(left) === runnerCauseKey(right) &&
    JSON.stringify([...left.seats].sort()) === JSON.stringify([...right.seats].sort())
  );
}

export function buildRunnerAdmissionChecks(checks: readonly ReadinessCheck[]): ReadinessCheck[] {
  const grouped = new Map<string, ReadinessCheck>();
  const result: ReadinessCheck[] = [];
  for (const check of checks) {
    const cause = check.runnerCause;
    if (cause === undefined) {
      result.push(check);
      continue;
    }
    const key = runnerCauseKey(cause);
    const existing = grouped.get(key);
    if (existing?.runnerCause !== undefined) {
      existing.runnerCause.seats.push(...cause.seats);
    } else {
      const entry = { ...check, runnerCause: { ...cause, seats: [...cause.seats] } };
      grouped.set(key, entry);
      result.push(entry);
    }
  }
  for (const check of grouped.values()) {
    const cause = check.runnerCause;
    if (cause === undefined) continue;
    const seats = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' }).format(
      cause.seats,
    );
    check.summary = `${seats} cannot start with ${CLI_TOOL_CATALOG[cause.tool].displayName}.`;
  }
  return result;
}
