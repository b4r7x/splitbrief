import { realpath } from 'node:fs/promises';
import { CONFIRM_PHRASE, type TieredApprovalRequest } from '../../core/approval/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { TaskId } from '../../core/schemas/task.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { assertNever } from '../../utils/type-guards.js';
import {
  formatCustomRunnerDisclosure,
  markCustomRunnerTrusted,
  parseConfiguredCustomRunner,
  parseCustomRunnerSecurityPosture,
  type ConfiguredCustomRunner,
  type CustomRunnerSecurityPosture,
} from './custom-trust.js';
import {
  admitCustomRunner,
  resolveCustomRunnerLaunchability,
  type CustomRunnerAdmission,
  type AdmitCustomRunnerOptions,
} from './trust.js';
import { resolveCustomExecutable } from './resolve-cli-executable.js';
import type { CustomRunnerAdmissionPolicy } from './types.js';

const RECEIPT_CONFIRMATION_NOTICE = 'Exact confirmation stores an owner-only reusable receipt.';

export interface PrepareCustomRunnerAdmissionOptions extends CustomRunnerAdmissionPolicy {
  readonly projectDir: string;
  readonly runner: ConfiguredCustomRunner;
  readonly posture: CustomRunnerSecurityPosture;
  readonly phase: Phase;
  readonly taskId?: TaskId | undefined;
  /** Executable-resolution authority, deliberately distinct from declared child environment. */
  readonly authorizationPathEnv?: string | undefined;
  /** Windows executable-extension authority, deliberately distinct from declared child environment. */
  readonly authorizationPathExt?: string | undefined;
}

function admissionOptions(
  options: PrepareCustomRunnerAdmissionOptions,
  input: Readonly<{
    interaction: 'interactive' | 'headless';
    grant: boolean;
  }>,
): AdmitCustomRunnerOptions {
  return {
    projectDir: options.projectDir,
    runner: options.runner,
    posture: options.posture,
    interaction: input.interaction,
    grant: input.grant,
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    pathEnv: options.authorizationPathEnv ?? '',
    pathExt: options.authorizationPathExt ?? '',
  };
}

function deniedAfterReAdmission(admission: CustomRunnerAdmission): CustomRunnerAdmission {
  return admission.kind === 'denied' ? admission : { kind: 'denied', status: 'invalid' };
}

function isExecutableLaunchability(
  launchability: Awaited<ReturnType<typeof resolveCustomRunnerLaunchability>>,
): launchability is Extract<
  Awaited<ReturnType<typeof resolveCustomRunnerLaunchability>>,
  { kind: 'resolved' | 'untrusted' | 'trusted' }
> {
  return (
    launchability.kind === 'resolved' ||
    launchability.kind === 'untrusted' ||
    launchability.kind === 'trusted'
  );
}

function isConfirmed(
  response: Awaited<ReturnType<NonNullable<CustomRunnerAdmissionPolicy['onTieredApproval']>>>,
): boolean {
  return (
    response.decision === 'confirm' &&
    response.phrase === CONFIRM_PHRASE &&
    response.reason.trim().length > 0
  );
}

function snapshotRunner(input: unknown): ConfiguredCustomRunner | null {
  const parsed = parseConfiguredCustomRunner(input);
  if (parsed === null) return null;
  return {
    source: 'configured',
    command: {
      id: parsed.command.id,
      label: parsed.command.label,
      contract: parsed.command.contract,
      executable: parsed.command.executable,
      argv: [...parsed.command.argv],
      outputFormat: parsed.command.outputFormat,
      idleWarnMs: parsed.command.idleWarnMs,
      idleKillMs: parsed.command.idleKillMs,
      env: [...parsed.command.env],
    },
  };
}

function snapshotPosture(input: unknown): CustomRunnerSecurityPosture | null {
  const parsed = parseCustomRunnerSecurityPosture(input);
  if (parsed === null) return null;
  return {
    role: parsed.role,
    cwd: parsed.cwd,
    stage: parsed.stage,
    filesystem: parsed.filesystem,
    network: parsed.network,
    result: parsed.result,
  };
}

async function captureOptions(
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
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    ...(options.onTieredApproval === undefined
      ? {}
      : { onTieredApproval: options.onTieredApproval }),
  };
}

function sourceStillMatchesSnapshots({
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

async function projectStillMatchesSnapshot({
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

function deniedPreMarkRevalidation(
  resolution: Awaited<ReturnType<typeof resolveCustomExecutable>>,
): CustomRunnerAdmission {
  switch (resolution.kind) {
    case 'identity-drifted':
      return { kind: 'denied', status: 'drifted' };
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

/**
 * Turns the T-026 trust result into the one user-facing configured-runner
 * admission flow. It intentionally returns no provisional grant: an
 * interactive confirmation becomes usable only after an owner-only receipt
 * is written and immediately re-admitted.
 */
export async function prepareCustomRunnerAdmission(
  options: PrepareCustomRunnerAdmissionOptions,
): Promise<CustomRunnerAdmission> {
  try {
    const capturedOptions = await captureOptions(options);
    if (capturedOptions === null) return { kind: 'denied', status: 'invalid' };
    const initial = await admitCustomRunner(
      admissionOptions(capturedOptions, {
        interaction: capturedOptions.interaction,
        grant: capturedOptions.interaction === 'headless' && capturedOptions.allowRepoRunners,
      }),
    );
    if (initial.kind !== 'disclosure-required') return initial;
    if (capturedOptions.interaction === 'headless') return { kind: 'denied', status: 'untrusted' };

    const disclosed = await resolveCustomRunnerLaunchability({
      projectDir: capturedOptions.projectDir,
      runner: capturedOptions.runner,
      posture: capturedOptions.posture,
      ...(capturedOptions.stateDir === undefined ? {} : { stateDir: capturedOptions.stateDir }),
      pathEnv: capturedOptions.authorizationPathEnv,
      pathExt: capturedOptions.authorizationPathExt,
    });
    if (!isExecutableLaunchability(disclosed)) return { kind: 'denied', status: 'invalid' };

    const request: TieredApprovalRequest = {
      tier: 'confirm',
      actionClass: 'network',
      actionDescription: `${formatCustomRunnerDisclosure(disclosed.disclosure)}\n\n${RECEIPT_CONFIRMATION_NOTICE}`,
      phase: capturedOptions.phase,
      ...(capturedOptions.taskId === undefined ? {} : { taskId: capturedOptions.taskId }),
    };
    if (capturedOptions.onTieredApproval === undefined)
      return { kind: 'denied', status: 'untrusted' };

    const response = await capturedOptions.onTieredApproval(request);
    if (!isConfirmed(response)) return { kind: 'denied', status: 'untrusted' };
    if (
      !(await projectStillMatchesSnapshot({
        originalProjectDir: options.projectDir,
        capturedProjectDir: capturedOptions.projectDir,
      }))
    ) {
      return { kind: 'denied', status: 'invalid' };
    }
    if (!sourceStillMatchesSnapshots({ options, captured: capturedOptions })) {
      return { kind: 'denied', status: 'invalid' };
    }

    const revalidated = await resolveCustomExecutable({
      command: capturedOptions.runner.command.executable,
      projectDir: capturedOptions.projectDir,
      expected: disclosed.executable,
      pathEnv: capturedOptions.authorizationPathEnv,
      pathExt: capturedOptions.authorizationPathExt,
    });
    if (revalidated.kind !== 'resolved') return deniedPreMarkRevalidation(revalidated);

    const trusted = await markCustomRunnerTrusted({
      projectDir: capturedOptions.projectDir,
      runner: capturedOptions.runner,
      posture: capturedOptions.posture,
      executable: disclosed.executable,
      ...(capturedOptions.stateDir === undefined ? {} : { stateDir: capturedOptions.stateDir }),
    });
    if (trusted.kind !== 'trusted') return { kind: 'denied', status: 'invalid' };

    const reAdmitted = await admitCustomRunner(
      admissionOptions(capturedOptions, { interaction: 'headless', grant: false }),
    );
    return reAdmitted.kind === 'admitted' ? reAdmitted : deniedAfterReAdmission(reAdmitted);
  } catch {
    return { kind: 'denied', status: 'invalid' };
  }
}
