import { join } from 'node:path';
import { clearStaleSession } from '../../../core/sessions/guards.js';
import { beginSession } from '../../../core/sessions/lifecycle.js';
import { sessionError } from '../../../core/sessions/errors.js';
import { collectReadiness } from '../../../core/readiness/collect.js';
import {
  createStartReadinessRecord,
  formatReadinessBlockers,
  readinessBlockerPointer,
} from '../../../core/readiness/format.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { READINESS_FILE, sessionDir } from '../../../core/paths.js';
import { writeSecureFile } from '../../../lib/fs.js';
import { cliError } from '../../errors.js';
import {
  admitFreshCliStart,
  cliStartGatesFromArray,
  revalidateCliStartGates,
  type CliStartGate,
  type CliStartGates,
} from '../../../engine/runners/start-gate.js';
import {
  detectAvailableCliReadiness,
  detectRunnerEvidence,
  runnerDiscoveryContextKey,
} from '../../../engine/detection/detect.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import {
  projectRunnerDiscoveryContext,
  type RunnerDiscoveryContext,
} from '../../../core/config/accessors/runner-config.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ImplementerConfig } from '../../../core/schemas/implementer-config.js';
import type { PlannerConfig } from '../../../core/schemas/planner-config.js';
import { resolveCliRunnerAuth } from '../../../engine/runners/sandbox-env.js';
import {
  CLI_TOOL_IDS,
  type CliAuthChannelId,
  type CliToolId,
} from '../../../core/runners/cli-tool-catalog.js';
import type {
  ExecutableIdentity,
  RunnerEvidence,
  StartAdmission,
} from '../../../core/discovery/runner-evidence.js';
import { assertNever, isRecord } from '../../../utils/type-guards.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import type { BootstrapSessionArgs, BootstrapSessionResult, DetectCliReadiness } from './types.js';

/**
 * Build one auth-channel selection per configured CLI tool, resolved through
 * the same rule execution uses, so a role that names no channel is probed on
 * the channel its runner will stage. A conflicting channel used by two roles is
 * intentionally left unselected so the probe cannot accidentally authorize
 * either role through an ambient credential.
 */
function configuredCliAuthChannels(
  config: Config,
): Partial<Record<CliToolId, CliAuthChannelId | undefined>> {
  const selections = new Map<CliToolId, CliAuthChannelId | undefined>();
  const add = (runner: Extract<PlannerConfig | ImplementerConfig, { kind: 'cli' }>): void => {
    const channel = resolveCliRunnerAuth(runner).id;
    if (!selections.has(runner.tool)) {
      selections.set(runner.tool, channel);
      return;
    }
    if (selections.get(runner.tool) !== channel) selections.set(runner.tool, undefined);
  };

  if (config.planner.kind === 'cli') add(config.planner);
  try {
    for (const profile of resolveImplementerProfiles(config).profiles) {
      if (profile.config.kind === 'cli') add(profile.config);
    }
  } catch {
    // Config readiness reports the invalid profile. Do not probe a guessed
    // tool/channel when the profile boundary cannot be resolved.
  }

  return Object.fromEntries(selections);
}

/**
 * Start-only detector. It deliberately skips the detection cache and probes
 * exactly the configured CLI tools through the canonical resolver/probe path.
 */
export const detectConfiguredCliReadiness: DetectCliReadiness = async ({ projectDir, config }) => {
  const authChannels = configuredCliAuthChannels(config);
  const tools = CLI_TOOL_IDS.filter((tool) => Object.hasOwn(authChannels, tool));
  if (tools.length === 0) return [];
  return detectAvailableCliReadiness({ projectDir, tools, authChannels });
};

export function persistStartReadiness(ref: SessionRef, report: ReadinessReport): void {
  const record = createStartReadinessRecord(report);
  writeSecureFile(
    join(sessionDir(ref.projectDir, ref.sessionId), READINESS_FILE),
    JSON.stringify(record, null, 2) + '\n',
  );
}

/**
 * Legacy CLI readiness remains a report, never an execution decision. Other
 * readiness blockers (invalid config, repository state, and so on) still stop
 * the command before its start-specific runner evidence is gathered.
 */
export function assertReadinessCanStart(report: ReadinessReport, json: boolean | undefined): void {
  const hasNonCliBlocker = report.sections.some((section) =>
    section.checks.some(
      (check) =>
        check.severity === 'blocker' &&
        !CLI_TOOL_IDS.some((tool) => check.id === `runners.cli.${tool}.readiness`),
    ),
  );
  if (hasNonCliBlocker) {
    if (!json) console.log(formatReadinessBlockers(report));
    throw cliError(readinessBlockerPointer(report), 1);
  }
}

type CliRunnerDiscoveryContext = RunnerDiscoveryContext & Readonly<{ kind: 'cli'; id: CliToolId }>;
type StartDenialReason = Extract<StartAdmission, { kind: 'denied' }>['reason'];

export interface AuthUnknownDisclosure {
  readonly role: CliRunnerDiscoveryContext['role'];
  readonly tool: CliToolId;
}

export interface AuthorizeConfiguredCliStartOptions {
  readonly projectDir: string;
  readonly config: Config;
  readonly interaction: 'interactive' | 'headless';
  readonly allowUnverifiedAuth: boolean;
  readonly detectEvidence?: typeof detectRunnerEvidence | undefined;
  readonly revalidateGates?: typeof revalidateCliStartGates | undefined;
  readonly onAuthUnknownDisclosure?: ((disclosure: AuthUnknownDisclosure) => void) | undefined;
}

function isCliRunnerDiscoveryContext(
  context: RunnerDiscoveryContext,
): context is CliRunnerDiscoveryContext {
  return context.kind === 'cli' && CLI_TOOL_IDS.some((tool) => tool === context.id);
}

function configuredCliContexts(config: Config): readonly CliRunnerDiscoveryContext[] {
  return [
    projectRunnerDiscoveryContext({ config, role: 'planner' }),
    projectRunnerDiscoveryContext({ config, role: 'implementer' }),
  ].filter(isCliRunnerDiscoveryContext);
}

function isExecutableIdentity(value: unknown): value is ExecutableIdentity {
  return (
    isRecord(value) &&
    typeof value.canonicalPath === 'string' &&
    typeof value.realPath === 'string' &&
    typeof value.platformFileId === 'string' &&
    typeof value.fingerprint === 'string' &&
    typeof value.resolvedAt === 'number'
  );
}

function attachedExecutableIdentity(gate: CliStartGate): ExecutableIdentity | null {
  const attached =
    'executableIdentity' in gate.executable ? gate.executable.executableIdentity : undefined;
  return isExecutableIdentity(attached) ? attached : null;
}

function sameExecutableIdentity(
  input: Readonly<{ left: ExecutableIdentity; right: ExecutableIdentity }>,
): boolean {
  return (
    input.left.canonicalPath === input.right.canonicalPath &&
    input.left.realPath === input.right.realPath &&
    input.left.platformFileId === input.right.platformFileId &&
    input.left.fingerprint === input.right.fingerprint
  );
}

function sameExecutable(input: Readonly<{ left: CliStartGate; right: CliStartGate }>): boolean {
  const left = attachedExecutableIdentity(input.left);
  const right = attachedExecutableIdentity(input.right);
  return left !== null && right !== null && sameExecutableIdentity({ left, right });
}

function formatFreshStartDenial(input: {
  role: CliRunnerDiscoveryContext['role'];
  tool: CliToolId;
  reason: StartDenialReason;
  interaction: 'interactive' | 'headless';
}): string {
  const prefix = `Start blocked: ${input.role} runner ${input.tool}`;
  switch (input.reason.kind) {
    case 'evidence-source':
      return `${prefix} was not checked freshly. Re-run start so it can collect new runner evidence.`;
    case 'context-mismatch':
      return `${prefix} changed while it was being checked. Review the selected runner, then start again.`;
    case 'disabled':
      return `${prefix} is disabled. Enable it in the active configuration before retrying.`;
    case 'installation':
      return `${prefix} is ${input.reason.fact}. Install or resolve the runner, then start again.`;
    case 'executable':
      return `${prefix} executable is ${input.reason.fact}. Restore and trust the exact executable, then retry.`;
    case 'compatibility':
      return `${prefix} version is ${input.reason.fact}. Install a tested compatible version, then retry.`;
    case 'authentication':
      return `${prefix} authentication is ${input.reason.fact}. Verify the selected auth channel before retrying.`;
    case 'authentication-unverified':
      return input.interaction === 'headless'
        ? `${prefix} authentication could not be verified. Verify it first, or pass --allow-unverified-auth after review.`
        : `${prefix} authentication could not be verified. Verify the selected auth channel before retrying.`;
    case 'probe':
      return `${prefix} ${input.reason.fact} check is ${input.reason.outcome}. Resolve it before retrying.`;
    case 'model-run':
      return `${prefix} model run is ${input.reason.fact}. Verify the selected model before retrying.`;
    case 'model-context-mismatch':
      return `${prefix} model selection changed while it was checked. Review it, then start again.`;
    default:
      return assertNever(input.reason);
  }
}

function assertEvidenceMatchesSelection(
  input: Readonly<{
    context: CliRunnerDiscoveryContext;
    evidence: RunnerEvidence;
  }>,
): void {
  if (
    input.evidence.runner.kind !== 'cli' ||
    input.evidence.runner.id !== input.context.id ||
    input.evidence.modelRun.selectionId !== (input.context.model ?? 'unselected')
  ) {
    throw cliError(
      formatFreshStartDenial({
        role: input.context.role,
        tool: input.context.id,
        reason: { kind: 'context-mismatch' },
        interaction: 'interactive',
      }),
      1,
    );
  }
}

function reportAuthUnknownDisclosure(disclosure: AuthUnknownDisclosure): void {
  console.error(
    `Authentication for compatibility runner ${disclosure.tool} could not be verified. This requested interactive run will use its authentication attempt as the test.`,
  );
}

/**
 * The only CLI admission boundary for `start`. It probes the active planner
 * and active implementer directly from the resolved config; it does not read
 * UI/store state or legacy readiness output.
 */
export async function authorizeConfiguredCliStart(
  options: AuthorizeConfiguredCliStartOptions,
): Promise<CliStartGates> {
  const detectEvidence = options.detectEvidence ?? detectRunnerEvidence;
  const gates = new Map<CliToolId, CliStartGate>();

  for (const context of configuredCliContexts(options.config)) {
    const expectedContextKey = runnerDiscoveryContextKey(context);
    const evidence = await detectEvidence({ context, projectDir: options.projectDir });
    assertEvidenceMatchesSelection({ context, evidence });
    const initial = admitFreshCliStart({
      tool: context.id,
      evidence,
      expectedContextKey,
      expectedSelectionId: context.model ?? 'unselected',
      interaction: options.interaction,
      unverifiedAuth:
        options.interaction === 'headless' && options.allowUnverifiedAuth ? 'allowed' : 'denied',
    });
    const decision =
      initial.kind === 'disclosure-required'
        ? admitAfterDisclosure({ context, evidence, expectedContextKey, options })
        : initial;

    if (decision.kind === 'disclosure-required') {
      throw cliError(
        formatFreshStartDenial({
          role: context.role,
          tool: context.id,
          reason: { kind: 'authentication-unverified' },
          interaction: options.interaction,
        }),
        1,
      );
    }
    if (decision.kind === 'denied') {
      throw cliError(
        formatFreshStartDenial({
          role: context.role,
          tool: context.id,
          reason: decision.reason,
          interaction: options.interaction,
        }),
        1,
      );
    }

    const existing = gates.get(context.id);
    if (existing !== undefined && !sameExecutable({ left: existing, right: decision.gate })) {
      throw cliError(
        `Start blocked: ${context.id} resolved to different executable identities for active roles. Re-run after resolving the configuration.`,
        1,
      );
    }
    gates.set(context.id, decision.gate);
  }

  return (options.revalidateGates ?? revalidateCliStartGates)({
    projectDir: options.projectDir,
    gates: cliStartGatesFromArray([...gates.values()]),
  });
}

function admitAfterDisclosure(input: {
  context: CliRunnerDiscoveryContext;
  evidence: RunnerEvidence;
  expectedContextKey: string;
  options: AuthorizeConfiguredCliStartOptions;
}) {
  input.options.onAuthUnknownDisclosure?.({ role: input.context.role, tool: input.context.id });
  return admitFreshCliStart({
    tool: input.context.id,
    evidence: input.evidence,
    expectedContextKey: input.expectedContextKey,
    expectedSelectionId: input.context.model ?? 'unselected',
    interaction: input.options.interaction,
    unverifiedAuth: 'disclosed',
  });
}

function isHeadlessStart(args: BootstrapSessionArgs): boolean {
  return (
    args.assertJson ||
    args.opts.json === true ||
    args.opts.rpc === true ||
    args.opts.detach === true
  );
}

function allowsUnverifiedAuth(opts: WorkflowOpts): boolean {
  return opts.allowUnverifiedAuth === true;
}

function reportFreshReconciliation(report: ReadinessReport, gates: CliStartGates): void {
  const staleCliResultWasReplaced = report.sections.some((section) =>
    section.checks.some((check) => {
      if (check.id.startsWith('runners.cli.') === false || check.metadata?.status === 'ready') {
        return false;
      }
      const configuredTool = CLI_TOOL_IDS.find((tool) => tool === check.metadata?.tool);
      return configuredTool !== undefined && gates.has(configuredTool);
    }),
  );
  if (staleCliResultWasReplaced) {
    console.error(
      'Runner readiness changed since the earlier report; start used the fresh result.',
    );
  }
}

export function clearStaleSessionForCli(projectDir: string): void {
  try {
    clearStaleSession(projectDir);
  } catch (err) {
    if (sessionError.isStillActive(err)) {
      throw cliError(err.message, 1);
    }
    throw err;
  }
}

export async function bootstrapSession(
  args: BootstrapSessionArgs,
): Promise<BootstrapSessionResult> {
  const readiness = await collectReadiness({
    projectDir: args.projectDir,
    opts: args.opts,
    probeValidation: true,
    ...(args.defaultApprove !== undefined && { defaultApprove: args.defaultApprove }),
    ...(args.cliReadiness !== undefined && { cliReadiness: args.cliReadiness }),
    ...(args.detectCliReadiness !== undefined && {
      detectCliReadiness: args.detectCliReadiness,
    }),
  });
  args.emitReadiness(readiness.report);
  assertReadinessCanStart(readiness.report, args.assertJson);
  if (readiness.config === undefined) {
    throw cliError(
      'Start blocked: no valid configuration was available for runner authorization.',
      1,
    );
  }
  const trustedCliGates = await authorizeConfiguredCliStart({
    projectDir: args.projectDir,
    config: readiness.config,
    interaction: isHeadlessStart(args) ? 'headless' : 'interactive',
    allowUnverifiedAuth: allowsUnverifiedAuth(args.opts),
    onAuthUnknownDisclosure: reportAuthUnknownDisclosure,
  });
  reportFreshReconciliation(readiness.report, trustedCliGates);
  clearStaleSessionForCli(args.projectDir);
  const persistTranscript = readiness.config.workflow.persistTranscript ?? true;
  const sessionId = beginSession(args.projectDir, args.feature, { persistTranscript });
  persistStartReadiness({ projectDir: args.projectDir, sessionId }, readiness.report);
  return {
    sessionId,
    readiness,
    trustedCliGates,
  };
}
