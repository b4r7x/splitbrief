import type {
  CliAuthState,
  CliExecutableIdentity,
  CliProviderAuth,
} from '../../../core/discovery/detection.js';
import type { AuthFact, ProbeOutcome } from '../../../core/discovery/runner-evidence.js';
import type { CliAuthChannelId, CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import { deriveCliReadiness, type CliReadinessResult } from '../../../core/schemas/readiness.js';
import type { CliAuthProbe, CliProbeOutput, CliVersionProbe } from './contract.js';
import { parseProviderOracleOutput } from './provider-oracle.js';

export type CliReadinessProbeEvidence = Readonly<{
  version: ProbeOutcome<string>;
  auth: AuthFact;
  /** What the credential oracle said; absent when no oracle ran. */
  providerAuth?: CliProviderAuth | undefined;
}>;

export function versionOutcomeFromProbe({
  probe,
  output,
}: Readonly<{
  probe: CliVersionProbe;
  output: CliProbeOutput;
}>): ProbeOutcome<string> {
  if (output.timedOut) return { kind: 'timeout' };
  if (output.outputExceeded || output.exitCode === null || output.exitCode !== 0) {
    return { kind: 'malformed' };
  }
  try {
    const outcome = probe.parse(output);
    return outcome.kind === 'success' && outcome.value.trim().length === 0
      ? { kind: 'malformed' }
      : outcome;
  } catch {
    return { kind: 'malformed' };
  }
}

export function authFactFromDeclaredProbe({
  probe,
  output,
  requiresCredential,
}: Readonly<{
  probe: Exclude<CliAuthProbe, { kind: 'not-run' }>;
  output: CliProbeOutput;
  requiresCredential: boolean;
}>): AuthFact {
  if (output.timedOut) return 'timeout';
  if (output.outputExceeded) return 'malformed';
  if (output.exitCode === null) return 'unknown';
  try {
    const auth = probe.parse(output);
    if (auth === 'verified' && output.exitCode !== 0) return 'unknown';
    if (auth === 'not-required' && requiresCredential) return 'unknown';
    return auth;
  } catch {
    return 'malformed';
  }
}

/**
 * Three-way oracle semantics. A listing that parsed cleanly is a probe that
 * ran and always wins: at least one entry verifies with per-provider facts,
 * and a clean zero is a truthful negative, never a presence fallback. Output
 * the oracle could not produce (nonzero exit, timeout, budget breach) or that
 * cannot be parsed falls back to bridged-state presence for the auth fact, so
 * detection is never worse than presence alone, and names why the listing was
 * unreadable rather than dropping the question.
 */
export function oracleAuthEvidence({
  output,
  presenceAvailable,
}: Readonly<{ output: CliProbeOutput; presenceAvailable: boolean }>): Pick<
  CliReadinessProbeEvidence,
  'auth' | 'providerAuth'
> {
  const fallbackAuth = presenceAvailable ? ('verified' as const) : ('missing' as const);
  if (output.timedOut || output.outputExceeded || output.exitCode !== 0) {
    return {
      auth: fallbackAuth,
      providerAuth: { kind: 'unreadable', reason: output.timedOut ? 'timeout' : 'exit-failure' },
    };
  }
  const parsed = parseProviderOracleOutput(output.stdout);
  if (parsed.kind !== 'success') {
    return { auth: fallbackAuth, providerAuth: { kind: 'unreadable', reason: 'parse-failure' } };
  }
  if (parsed.entries.length === 0) return { auth: 'missing', providerAuth: { kind: 'empty' } };
  return { auth: 'verified', providerAuth: { kind: 'read', facts: parsed.entries } };
}

export function legacyAuthState(auth: AuthFact): CliAuthState {
  switch (auth) {
    case 'verified':
      return 'authenticated';
    case 'missing':
      return 'unauthenticated';
    case 'not-required':
      return 'not-required';
    case 'not-run':
      return 'not-checked';
    case 'not-selected':
    case 'unknown':
    case 'invalid':
    case 'policy-denied':
    case 'offline':
    case 'timeout':
    case 'malformed':
    case 'cancelled':
      return 'unknown';
  }
}

export function extractVersion(output: CliProbeOutput): string | null {
  const match = `${output.stdout}\n${output.stderr}`.match(
    /(?:^|\s|v)(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/,
  );
  return match?.[1] ?? null;
}

export function readinessExecutable(executable: CliExecutableIdentity): CliExecutableIdentity {
  return {
    path: executable.path,
    fingerprint: {
      dev: executable.fingerprint.dev,
      ino: executable.fingerprint.ino,
      size: executable.fingerprint.size,
      mtimeMs: executable.fingerprint.mtimeMs,
    },
  };
}

export function untrustedResult({
  base,
  executable,
  installedVersion,
}: Readonly<{
  base: Readonly<{
    tool: CliToolId;
    enabled: boolean;
    testedVersion: string;
    probedAt: number;
    authChannel?: CliAuthChannelId | undefined;
  }>;
  executable: CliExecutableIdentity;
  installedVersion: string | null;
}>): CliReadinessResult {
  return deriveCliReadiness({
    ...base,
    installation: 'installed',
    executable: readinessExecutable(executable),
    trust: 'untrusted',
    installedVersion,
    compatibility: 'not-checked',
    auth: 'not-checked',
  });
}
