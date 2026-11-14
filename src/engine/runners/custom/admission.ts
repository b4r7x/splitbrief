import { CONFIRM_PHRASE, type TieredApprovalRequest } from '../../../core/approval/types.js';
import { throwIfAborted, isAbortError } from '../../../utils/abort.js';
import { error } from '../../../utils/error.js';
import { resolveCustomExecutable } from '../cli-executable/custom.js';
import type { CustomRunnerAdmissionPolicy } from '../types.js';
import { formatCustomRunnerTrustRequest } from './disclosure.js';
import {
  type AdmitCustomRunnerOptions,
  type CustomRunnerAdmission,
  resolveCustomRunnerLaunchability,
  admitCustomRunner,
} from './launchability.js';
import {
  captureOptions,
  projectStillMatchesSnapshot,
  sourceStillMatchesSnapshots,
  deniedPreMarkRevalidation,
} from './snapshots.js';
import { markCustomRunnerTrusted } from './trust.js';
import type {
  PrepareCustomRunnerAdmissionOptions,
  PreparedCustomRunnerAdmission,
} from './types.js';

export const CUSTOM_RUNNER_TRUST_PERSISTED_AFTER_ABORT =
  'custom-runner-trust-persisted-after-abort';

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
  { kind: 'resolved' | 'untrusted' | 'drifted' | 'trusted' }
> {
  return (
    launchability.kind === 'resolved' ||
    launchability.kind === 'untrusted' ||
    launchability.kind === 'drifted' ||
    launchability.kind === 'trusted'
  );
}

function isConfirmed(
  response: Awaited<ReturnType<NonNullable<CustomRunnerAdmissionPolicy['onTieredApproval']>>>,
): boolean {
  return response.decision === 'confirm' && response.phrase === CONFIRM_PHRASE;
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
    const declined = {
      kind: 'denied',
      status: disclosed.kind === 'drifted' ? 'drifted' : 'untrusted',
    } as const;

    const request: TieredApprovalRequest = {
      tier: 'confirm',
      actionClass: 'runner_trust',
      actionDescription: formatCustomRunnerTrustRequest(
        disclosed.disclosure,
        disclosed.kind === 'drifted',
      ),
      phase: capturedOptions.phase,
      ...(capturedOptions.taskId === undefined ? {} : { taskId: capturedOptions.taskId }),
    };
    if (capturedOptions.onTieredApproval === undefined) return declined;

    const response = await capturedOptions.onTieredApproval(request);
    throwIfAborted(options.signal);
    if (!isConfirmed(response)) return declined;
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
    if (revalidated.kind !== 'resolved') return deniedPreMarkRevalidation(revalidated, declined);

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
