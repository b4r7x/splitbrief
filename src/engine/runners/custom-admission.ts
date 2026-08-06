import { realpath } from 'node:fs/promises';
import { CONFIRM_PHRASE, type TieredApprovalRequest } from '../../core/approval/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { TaskId } from '../../core/schemas/task.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { isAbortError, throwIfAborted } from '../../utils/abort.js';
import { error } from '../../utils/error.js';
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

export const CUSTOM_RUNNER_TRUST_PERSISTED_AFTER_ABORT =
  'custom-runner-trust-persisted-after-abort';

export type PreparedCustomRunnerAdmission =
  | Exclude<CustomRunnerAdmission, { kind: 'admitted' }>
  | (Extract<CustomRunnerAdmission, { kind: 'admitted' }> & Readonly<{ trustPersisted: boolean }>);

export interface PrepareCustomRunnerAdmissionOptions extends CustomRunnerAdmissionPolicy {
  readonly projectDir: string;
  readonly runner: ConfiguredCustomRunner;
  readonly posture: CustomRunnerSecurityPosture;
  readonly phase: Phase;
  readonly taskId?: TaskId | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly _beforeTrustWrite?: (() => void) | undefined;
  readonly _afterTrustWrite?: (() => void) | undefined;
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

function deniedAfterReAdmission(
  admission: CustomRunnerAdmission,
): Extract<CustomRunnerAdmission, { kind: 'denied' }> {
  return admission.kind === 'denied' ? admission : { kind: 'denied', status: 'invalid' };
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function trustPersistedAbortError(): Error {
  return error(
    CUSTOM_RUNNER_TRUST_PERSISTED_AFTER_ABORT,
    'Runner trust was saved before preparation cancellation completed.',
  );
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
): Extract<CustomRunnerAdmission, { kind: 'denied' }> {
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
): Promise<PreparedCustomRunnerAdmission> {
  try {
    throwIfAborted(options.signal);
    const capturedOptions = await captureOptions(options);
    throwIfAborted(options.signal);
    if (capturedOptions === null) return { kind: 'denied', status: 'invalid' };
    const initial = await admitCustomRunner(
      admissionOptions(capturedOptions, {
        interaction: capturedOptions.interaction,
        grant: capturedOptions.interaction === 'headless' && capturedOptions.allowRepoRunners,
      }),
    );
    throwIfAborted(options.signal);
    if (initial.kind !== 'disclosure-required') {
      return initial.kind === 'admitted' ? { ...initial, trustPersisted: false } : initial;
    }
    if (capturedOptions.interaction === 'headless') return { kind: 'denied', status: 'untrusted' };

    const disclosed = await resolveCustomRunnerLaunchability({
      projectDir: capturedOptions.projectDir,
      runner: capturedOptions.runner,
      posture: capturedOptions.posture,
      ...(capturedOptions.stateDir === undefined ? {} : { stateDir: capturedOptions.stateDir }),
      pathEnv: capturedOptions.authorizationPathEnv,
      pathExt: capturedOptions.authorizationPathExt,
    });
    throwIfAborted(options.signal);
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
    throwIfAborted(options.signal);
    if (!isConfirmed(response)) return { kind: 'denied', status: 'untrusted' };
    const projectMatches = await projectStillMatchesSnapshot({
      originalProjectDir: options.projectDir,
      capturedProjectDir: capturedOptions.projectDir,
    });
    throwIfAborted(options.signal);
    if (!projectMatches) {
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
    throwIfAborted(options.signal);
    if (revalidated.kind !== 'resolved') return deniedPreMarkRevalidation(revalidated);

    throwIfAborted(options.signal);
    const trusted = await markCustomRunnerTrusted({
      projectDir: capturedOptions.projectDir,
      runner: capturedOptions.runner,
      posture: capturedOptions.posture,
      executable: disclosed.executable,
      ...(capturedOptions.stateDir === undefined ? {} : { stateDir: capturedOptions.stateDir }),
      signal: options.signal,
      ...(capturedOptions._beforeTrustWrite === undefined
        ? {}
        : { _beforeWrite: capturedOptions._beforeTrustWrite }),
      ...(capturedOptions._afterTrustWrite === undefined
        ? {}
        : { _afterWrite: capturedOptions._afterTrustWrite }),
    });
    if (trusted.kind !== 'trusted') return { kind: 'denied', status: 'invalid' };
    if (trusted.abortedAfterPublication || signalIsAborted(options.signal)) {
      throw trustPersistedAbortError();
    }

    const reAdmitted = await admitCustomRunner(
      admissionOptions(capturedOptions, { interaction: 'headless', grant: false }),
    );
    if (signalIsAborted(options.signal)) {
      throw trustPersistedAbortError();
    }
    return reAdmitted.kind === 'admitted'
      ? { ...reAdmitted, trustPersisted: true }
      : deniedAfterReAdmission(reAdmitted);
  } catch (cause) {
    if (options.signal?.aborted === true || isAbortError(cause)) throw cause;
    return { kind: 'denied', status: 'invalid' };
  }
}
