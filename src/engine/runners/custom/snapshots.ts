import { realpath } from 'node:fs/promises';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { resolveCustomExecutable } from '../cli-executable/custom.js';
import type { CustomRunnerAdmission } from './launchability.js';
import {
  type ConfiguredCustomRunner,
  parseConfiguredCustomRunner,
  type CustomRunnerSecurityPosture,
  parseCustomRunnerSecurityPosture,
} from './posture.js';
import type { PrepareCustomRunnerAdmissionOptions } from './types.js';

function snapshotRunner(input: unknown): ConfiguredCustomRunner | null {
  const parsed = parseConfiguredCustomRunner(input);
  if (parsed === null) return null;
  return {
    source: parsed.source,
    command: {
      id: parsed.command.id,
      label: parsed.command.label,
      contract: parsed.command.contract,
      executable: parsed.command.executable,
      argv: [...parsed.command.argv],
      outputFormat: parsed.command.outputFormat,
      idleWarnMs: parsed.command.idleWarnMs,
      idleKillMs: parsed.command.idleKillMs,
      maxToolCalls: parsed.command.maxToolCalls,
      env: [...parsed.command.env],
    },
  };
}

function snapshotPosture(input: unknown): CustomRunnerSecurityPosture | null {
  const parsed = parseCustomRunnerSecurityPosture(input);
  if (parsed === null) return null;
  return {
    role: parsed.role,
    source: parsed.source,
    cwd: parsed.cwd,
    stage: parsed.stage,
    environmentAccess: parsed.environmentAccess,
    filesystem: parsed.filesystem,
    network: parsed.network,
    result: parsed.result,
  };
}

export async function captureOptions(
  options: PrepareCustomRunnerAdmissionOptions,
): Promise<PrepareCustomRunnerAdmissionOptions | null> {
  let projectDir: string;
  try {
    projectDir = await realpath(options.projectDir);
  } catch {
    return null;
  }
  const runner = snapshotRunner(options.runner);
  const posture = snapshotPosture(options.posture);
  if (runner === null || posture === null) return null;
  return {
    projectDir,
    runner,
    posture,
    phase: options.phase,
    interaction: options.interaction,
    allowRepoRunners: options.allowRepoRunners,
    authorizationPathEnv: options.authorizationPathEnv ?? '',
    authorizationPathExt: options.authorizationPathExt ?? '',
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options._beforeTrustWrite === undefined
      ? {}
      : { _beforeTrustWrite: options._beforeTrustWrite }),
    ...(options._afterTrustWrite === undefined
      ? {}
      : { _afterTrustWrite: options._afterTrustWrite }),
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    ...(options.onTieredApproval === undefined
      ? {}
      : { onTieredApproval: options.onTieredApproval }),
  };
}

export function sourceStillMatchesSnapshots({
  options,
  captured,
}: Readonly<{
  options: PrepareCustomRunnerAdmissionOptions;
  captured: PrepareCustomRunnerAdmissionOptions;
}>): boolean {
  const runner = snapshotRunner(options.runner);
  const posture = snapshotPosture(options.posture);
  return (
    runner !== null &&
    posture !== null &&
    canonicalJSON(runner) === canonicalJSON(captured.runner) &&
    canonicalJSON(posture) === canonicalJSON(captured.posture)
  );
}

export async function projectStillMatchesSnapshot({
  originalProjectDir,
  capturedProjectDir,
}: Readonly<{
  originalProjectDir: string;
  capturedProjectDir: string;
}>): Promise<boolean> {
  try {
    return (await realpath(originalProjectDir)) === capturedProjectDir;
  } catch {
    return false;
  }
}

export function deniedPreMarkRevalidation(
  resolution: Awaited<ReturnType<typeof resolveCustomExecutable>>,
  declined: Extract<CustomRunnerAdmission, { kind: 'denied' }>,
): Extract<CustomRunnerAdmission, { kind: 'denied' }> {
  switch (resolution.kind) {
    case 'identity-drifted':
      return declined;
    case 'missing':
    case 'non-executable':
    case 'invalid':
      return { kind: 'denied', status: resolution.kind };
    case 'resolved':
      return { kind: 'denied', status: 'invalid' };
    default:
      return assertNever(resolution);
  }
}
