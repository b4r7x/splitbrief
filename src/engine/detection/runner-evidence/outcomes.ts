import type { CliExecutableIdentity } from '../../../core/discovery/detection/executable.js';
import type { AuthFact, RunnerEvidence } from '../../../core/discovery/runner-evidence.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool/catalog.js';
import { matches } from '../../../utils/error.js';
import type { CliRunnerDiscoveryContext } from '../cli-context.js';
import { runnerEvidenceBase, executableFactFromResolved, credentialFromCliAuth } from './facts.js';

export function unresolvedCliEvidence(
  context: CliRunnerDiscoveryContext,
  observedAt: number,
  cause: unknown,
): RunnerEvidence {
  const base = runnerEvidenceBase(context, observedAt);
  if (matches('cli-executable-untrusted')(cause)) {
    return {
      ...base,
      installation: 'installed',
      executable: { kind: 'untrusted' },
      compatibility: {
        kind: 'unknown',
        installedVersion: null,
        testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
      },
      credential: 'unknown',
      auth: 'not-run',
    };
  }
  if (matches('cli-executable-identity-drift')(cause)) {
    return {
      ...base,
      installation: 'installed',
      executable: { kind: 'identity-drifted' },
      compatibility: {
        kind: 'unknown',
        installedVersion: null,
        testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
      },
      credential: 'unknown',
      auth: 'cancelled',
    };
  }
  if (matches('cli-executable-unavailable')(cause)) {
    return {
      ...base,
      installation: 'missing',
      executable: { kind: 'missing' },
      compatibility: {
        kind: 'unknown',
        installedVersion: null,
        testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
      },
      credential: 'unknown',
      auth: 'not-run',
    };
  }
  return {
    ...base,
    installation: 'unknown',
    executable: { kind: 'unknown' },
    compatibility: {
      kind: 'unknown',
      installedVersion: null,
      testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
    },
    credential: 'unknown',
    auth: 'unknown',
  };
}

export function probeFailureEvidence(
  context: CliRunnerDiscoveryContext,
  observedAt: number,
  executable: CliExecutableIdentity,
): RunnerEvidence {
  const base = runnerEvidenceBase(context, observedAt);
  return {
    ...base,
    installation: 'installed',
    executable: executableFactFromResolved(executable),
    compatibility: {
      kind: 'unknown',
      installedVersion: null,
      testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
    },
    credential: context.credentialPresent ? 'present' : 'unknown',
    auth: 'unknown',
  };
}

export function cancelledProbeEvidence(
  context: CliRunnerDiscoveryContext,
  observedAt: number,
  auth: AuthFact,
): RunnerEvidence {
  const base = runnerEvidenceBase(context, observedAt);
  return {
    ...base,
    installation: 'installed',
    executable: { kind: 'identity-drifted' },
    compatibility: {
      kind: 'unknown',
      installedVersion: null,
      testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
    },
    credential: credentialFromCliAuth(context, auth),
    auth,
  };
}
