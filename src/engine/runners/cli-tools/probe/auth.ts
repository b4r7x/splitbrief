import type { CliToolId } from '../../../../core/runners/cli-tool/types.js';
import { isRecord } from '../../../../utils/type-guards.js';
import type { CliProbeOutput, CliAuthProbe } from './contract.js';
import {
  providerOracleCommand,
  providerOracleLegacyCommand,
  providerOracleAuthFact,
} from './provider-oracle.js';
import { PROBE_OUTPUT_MAX_BYTES, PROVIDER_ORACLE_OUTPUT_MAX_BYTES } from './version.js';

function jsonAuthFact(output: CliProbeOutput): ReturnType<typeof authFactFromText> | undefined {
  const text = output.stdout.trim();
  if (text.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    if (parsed.loggedIn === true || parsed.authenticated === true) return 'verified';
    if (parsed.loggedIn === false || parsed.authenticated === false) return 'missing';
    return typeof parsed.status === 'string' ? authFactFromText(parsed.status) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The words a runner uses when it could not reach the network at all. Shared
 * with the seat-trouble classifier: an unreachable endpoint is a fact about the
 * machine and is retried, so it must never be read as an auth fact either.
 */
const OFFLINE_TEXT_MARKERS: readonly string[] = ['offline', 'network', 'connection refused', 'dns'];

export function looksOfflineDiagnostic(value: string): boolean {
  const text = value.trim().toLowerCase();
  return OFFLINE_TEXT_MARKERS.some((marker) => text.includes(marker));
}

function authFactFromText(value: string) {
  const text = value.trim().toLowerCase();
  if (text.length === 0) return undefined;
  // Negated forms come first: `not authenticated` and `not signed in` contain
  // the positive tokens the verified arm matches on.
  if (
    text.includes('not logged in') ||
    text.includes('not authenticated') ||
    text.includes('not signed in') ||
    text.includes('no active session') ||
    text.includes('unauthenticated') ||
    text.includes('no credential') ||
    text.includes('missing credential')
  ) {
    return 'missing' as const;
  }
  if (
    text.includes('logged in') ||
    text.includes('logged_in') ||
    text.includes('authenticated') ||
    text.includes('auth mode')
  ) {
    return 'verified' as const;
  }
  if (
    text.includes('invalid') ||
    text.includes('expired') ||
    text.includes('unauthorized') ||
    text.includes('authentication failed')
  ) {
    return 'invalid' as const;
  }
  if (text.includes('policy') || text.includes('forbidden') || text.includes('access denied')) {
    return 'policy-denied' as const;
  }
  if (looksOfflineDiagnostic(text)) return 'offline' as const;
  return undefined;
}

// A positive local status proves a credential is present; liveness is established
// by the first real call, which carries its own failure remediation.
function parseStatusAuth(output: CliProbeOutput) {
  const fromJson = jsonAuthFact(output);
  if (fromJson !== undefined) return fromJson;
  return authFactFromText(`${output.stdout}\n${output.stderr}`) ?? 'malformed';
}

// `cmd` exits 3 for "not authenticated" even when it prints nothing; every
// other code falls through to the shared status parsing.
function parseCommandCodeStatusAuth(output: CliProbeOutput) {
  if (output.exitCode === 3) return 'missing' as const;
  return parseStatusAuth(output);
}

export function declaredAuthProbe(tool: CliToolId, command: string): CliAuthProbe {
  switch (tool) {
    case 'claude-code':
      return {
        kind: 'auth-status',
        command: [command, 'auth', 'status'],
        cwd: 'neutral',
        maxOutputBytes: PROBE_OUTPUT_MAX_BYTES,
        parse: parseStatusAuth,
      };
    case 'codex':
      return {
        kind: 'auth-status',
        command: [command, 'login', 'status'],
        cwd: 'neutral',
        maxOutputBytes: PROBE_OUTPUT_MAX_BYTES,
        parse: parseStatusAuth,
      };
    // OpenCode and Kilo expose a read-only per-provider credential listing
    // that names each stored credential and recognized env var without ever
    // printing values. When its output cannot be parsed, the readiness probe
    // falls back to allowlisted-state presence.
    case 'opencode':
    case 'kilo-code': {
      const oracle = providerOracleCommand(tool);
      if (oracle === undefined) return { kind: 'not-run' };
      const legacy = providerOracleLegacyCommand(tool);
      return {
        kind: 'auth-status',
        command: oracle,
        cwd: 'neutral',
        maxOutputBytes: PROVIDER_ORACLE_OUTPUT_MAX_BYTES,
        parse: providerOracleAuthFact,
        ...(legacy === undefined ? {} : { legacy }),
      };
    }
    case 'cursor':
      return {
        kind: 'auth-status',
        command: [command, 'status'],
        cwd: 'neutral',
        maxOutputBytes: PROBE_OUTPUT_MAX_BYTES,
        parse: parseStatusAuth,
      };
    // Every `cmd` start checks for an update in the background and spawns a
    // detached installer unless the argv names `--no-auto-update`. The status
    // and listing probes wait on the network long enough for that check to
    // land (cmd went 1.62.1 -> 1.64.0 under a listing probe), so both carry it.
    case 'command-code':
      return {
        kind: 'auth-status',
        command: [command, 'status', '--json', '--no-auto-update'],
        cwd: 'neutral',
        maxOutputBytes: PROBE_OUTPUT_MAX_BYTES,
        parse: parseCommandCodeStatusAuth,
      };
    case 'antigravity':
      return {
        kind: 'auth-status',
        command: [command, 'models'],
        cwd: 'neutral',
        maxOutputBytes: PROBE_OUTPUT_MAX_BYTES,
        // `agy models` needs a signed-in account to list anything, so a
        // non-zero exit is the missing-credential answer.
        parse: (output) => (output.exitCode === 0 ? 'verified' : 'missing'),
      };
    case 'copilot':
      return { kind: 'not-run' };
  }
}
