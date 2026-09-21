import type {
  CliExecutableFingerprint,
  CliExecutableIdentity,
} from '../../core/discovery/detection.js';
import { admitCliAuthChannel } from '../../core/runners/cli-auth-selection.js';
import {
  selectCliAuthChannel,
  type CliAuthEnforcementEvidence,
  type CliAuthMethod,
} from '../../core/runners/cli-tool-catalog.js';
import type { RunnerBillingPosture } from '../../core/runners/runner-billing.js';
import type { PlannerConfig } from '../../core/schemas/planner-config.js';
import type { ImplementerConfig } from '../../core/schemas/implementer-config.js';
import { error } from '../../utils/error.js';

type CliRunner = Extract<PlannerConfig | ImplementerConfig, { kind: 'cli' }>;

/** The one invocation a method is bound to: its call and the admitted binary it spawns. */
export type CliInvocation = Readonly<{
  callId: string;
  executable: CliExecutableIdentity;
  installedVersion: string | undefined;
  platform: NodeJS.Platform;
}>;

/**
 * What one CLI invocation may claim about its authentication method. No
 * credential value, argv, env or auth store path ever enters it. `enforced`
 * needs a positive matrix row for this exact adapter, platform and version;
 * `observed` needs the tool's own same-invocation report of its method, which
 * no admitted adapter supplies today, so nothing produces it yet.
 */
export type CliInvocationAuthEvidence =
  | Readonly<{ kind: 'host-configured' }>
  | Readonly<{
      kind: 'enforced';
      channel: CliAuthMethod;
      evidenceId: string;
      invocationId: string;
      executableFingerprint: CliExecutableFingerprint;
      platform: NodeJS.Platform;
      installedVersion: string;
      billingPosture: RunnerBillingPosture;
    }>
  | Readonly<{
      kind: 'observed';
      channel: CliAuthMethod;
      evidenceId: string;
      invocationId: string;
      executableFingerprint: CliExecutableFingerprint;
      billingPosture: RunnerBillingPosture;
    }>;

/**
 * Admits a runner's raw `authChannel` for one invocation, before dispatch. An
 * omitted or provider-dependent channel runs on the host CLI's configuration.
 * An explicit method runs only with current proof and otherwise throws — it is
 * never reinterpreted as host-configured.
 */
export function enforceCliAuthInvocation({
  runner,
  invocation,
  evidence,
}: Readonly<{
  runner: CliRunner;
  invocation: CliInvocation;
  evidence?: readonly CliAuthEnforcementEvidence[] | undefined;
}>): CliInvocationAuthEvidence {
  const admission = admitCliAuthChannel({
    tool: runner.tool,
    platform: invocation.platform,
    installedVersion: invocation.installedVersion,
    authChannel: runner.authChannel,
    ...(evidence !== undefined && { evidence }),
  });
  if (admission.kind === 'host-configured') return admission;
  // An enforced admission is only ever issued for an exact installed version.
  if (admission.kind === 'enforced' && invocation.installedVersion !== undefined) {
    return {
      kind: 'enforced',
      channel: admission.channel,
      evidenceId: admission.evidenceId,
      invocationId: invocation.callId,
      executableFingerprint: invocation.executable.fingerprint,
      platform: invocation.platform,
      installedVersion: invocation.installedVersion,
      billingPosture:
        selectCliAuthChannel(runner.tool, { channel: admission.channel })?.billing ?? 'unknown',
    };
  }
  throw error(
    'runner-auth-channel-unenforced',
    admission.kind === 'refused'
      ? admission.message
      : `authChannel "${admission.channel}" has no installed version to bind.`,
    { tool: runner.tool, authChannel: admission.channel },
  );
}
