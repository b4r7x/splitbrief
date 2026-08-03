import type { Config } from '../../core/schemas/config.js';
import {
  findConfiguredCustomCommand,
  isCustomCommandRunner,
  type CustomCommandRunner,
} from '../../core/config/custom-commands.js';
import {
  commandTokensAfterInterpreter,
  isPathLike,
  isRepoLocal,
  isBareCommandResolvedInsideProject,
  isPackageManagerScriptInvocation,
  isShellEvaluatedPromptArg,
} from '../../core/trust/path-classification.js';
import { stripProfileMetadata } from '../../core/config/accessors/implementer-profiles.js';
import { parseShellCommand } from '../../utils/parse-shell-command.js';
import { error } from '../../utils/error.js';
import {
  buildCustomRunnerDisclosure,
  parseConfiguredCustomRunner,
  parseCustomRunnerAdmissionScope,
  parseCustomRunnerSecurityPosture,
  readCustomRunnerTrust,
  resolveCustomRunnerAdmissionScope,
  type CustomRunnerAdmissionScope,
  type CustomRunnerDisclosure,
  type ConfiguredCustomRunner,
  type CustomRunnerSecurityPosture,
  type CustomRunnerTrustReceipt,
} from './custom-trust.js';
import {
  revalidateCliExecutableIdentity,
  resolveCustomExecutable,
  type ResolveCustomExecutableOptions,
} from './resolve-cli-executable.js';
import { CliExecutableReceiptSchema } from '../../core/discovery/detection.js';
import type { CliExecutableReceipt } from '../../core/discovery/detection.js';

function tokenIsRepoLocalExecutable(token: string, projectDir: string): boolean {
  if (!isPathLike(token) || !isRepoLocal(token, projectDir)) return false;
  return true;
}

function flagValue(token: string): string | null {
  const eq = token.indexOf('=');
  if (eq === -1) return null;
  const value = token.slice(eq + 1);
  return value.length > 0 ? value : null;
}

function commandHasRepoLocalPaths(
  command: string,
  args: readonly string[],
  projectDir: string,
): boolean {
  const tokens = [...parseShellCommand(command), ...args];
  const executable = tokens[0];
  if (executable && isBareCommandResolvedInsideProject(executable, projectDir)) return true;
  if (isPackageManagerScriptInvocation(tokens)) return true;

  const checkTokens = commandTokensAfterInterpreter(tokens);
  for (const token of checkTokens) {
    const candidate = token.startsWith('-') ? flagValue(token) : token;
    if (candidate === null) continue;
    if (tokenIsRepoLocalExecutable(candidate, projectDir)) return true;
  }
  return false;
}

export interface RunnerTrustViolation {
  label: string;
  command: string;
}

export interface RunnerTrustResult {
  untrustedCommands: string[];
  violations: RunnerTrustViolation[];
}

export type CustomRunnerLaunchability =
  | Readonly<{
      kind: 'resolved' | 'untrusted';
      executable: Extract<
        Awaited<ReturnType<typeof resolveCustomExecutable>>,
        { kind: 'resolved' }
      >['executable'];
      disclosure: CustomRunnerDisclosure;
    }>
  | Readonly<{
      kind: 'trusted';
      executable: Extract<
        Awaited<ReturnType<typeof resolveCustomExecutable>>,
        { kind: 'resolved' }
      >['executable'];
      disclosure: CustomRunnerDisclosure;
      receipt: CustomRunnerTrustReceipt;
    }>
  | Readonly<{ kind: 'missing' | 'non-executable' | 'drifted' | 'invalid' }>;

export type AdmittedCustomRunnerInvocation = Readonly<{
  kind: 'custom-runner-invocation';
  runner: ConfiguredCustomRunner;
  posture: CustomRunnerSecurityPosture;
  executable: CliExecutableReceipt;
  authorization: 'receipt' | 'explicit-grant';
  scope: CustomRunnerAdmissionScope;
}>;

export type CustomRunnerAdmission =
  | Readonly<{
      kind: 'admitted';
      invocation: AdmittedCustomRunnerInvocation;
    }>
  | Readonly<{ kind: 'disclosure-required'; disclosure: CustomRunnerDisclosure }>
  | Readonly<{
      kind: 'denied';
      status: CustomRunnerLaunchability['kind'];
    }>;

export const customRunnerAdmissionError = {
  invalid: () => error('custom-runner-admission-invalid', 'Custom runner admission is invalid.'),
  denied: (role: 'planner' | 'implementer') =>
    error(
      'custom-runner-admission-denied',
      role === 'planner'
        ? 'Configured custom planner admission was denied.'
        : 'Configured custom runner admission was denied.',
    ),
  scopeMismatch: () =>
    error(
      'custom-runner-admission-scope-mismatch',
      'Custom runner admission no longer matches this project and definition.',
    ),
  executableMissing: () =>
    error(
      'custom-runner-executable-missing',
      'Custom runner executable is no longer available. Re-run custom runner admission before execution.',
    ),
  executableDrifted: () =>
    error(
      'custom-runner-executable-drifted',
      'Custom runner executable identity changed. Re-run custom runner admission before execution.',
    ),
  executableResolutionDrifted: () =>
    error(
      'custom-runner-executable-resolution-drifted',
      'Custom runner executable no longer resolves to the admitted identity.',
    ),
} as const;

export interface ResolveCustomRunnerLaunchabilityOptions {
  readonly projectDir: string;
  readonly runner: unknown;
  readonly posture: CustomRunnerSecurityPosture | unknown;
  readonly stateDir?: string | undefined;
  readonly pathEnv?: string | undefined;
  readonly pathExt?: string | undefined;
  readonly resolveExecutable?:
    | ((options: ResolveCustomExecutableOptions) => ReturnType<typeof resolveCustomExecutable>)
    | undefined;
}

export interface AdmitCustomRunnerOptions extends ResolveCustomRunnerLaunchabilityOptions {
  readonly interaction: 'interactive' | 'headless';
  readonly grant: boolean;
}

export interface RevalidateCustomRunnerInvocationOptions {
  readonly invocation: unknown;
  readonly projectDir: string;
  readonly pathEnv?: string | undefined;
  readonly pathExt?: string | undefined;
}

function isCustomRunnerAuthorization(
  value: unknown,
): value is AdmittedCustomRunnerInvocation['authorization'] {
  return value === 'receipt' || value === 'explicit-grant';
}

function admissionScopesEqual(
  left: CustomRunnerAdmissionScope,
  right: CustomRunnerAdmissionScope,
): boolean {
  return (
    left.projectIdentity === right.projectIdentity &&
    left.definitionId === right.definitionId &&
    left.definitionDigest === right.definitionDigest
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAdmittedCustomRunnerInvocation(
  input: unknown,
): AdmittedCustomRunnerInvocation | null {
  if (!isRecord(input) || input.kind !== 'custom-runner-invocation') return null;
  const runner = parseConfiguredCustomRunner(input.runner);
  const posture = parseCustomRunnerSecurityPosture(input.posture);
  const executable = CliExecutableReceiptSchema.safeParse(input.executable);
  const scope = parseCustomRunnerAdmissionScope(input.scope);
  if (
    runner === null ||
    posture === null ||
    !executable.success ||
    scope === null ||
    !isCustomRunnerAuthorization(input.authorization)
  ) {
    return null;
  }
  return {
    kind: 'custom-runner-invocation',
    runner,
    posture,
    executable: executable.data,
    authorization: input.authorization,
    scope,
  };
}

function createAdmittedCustomRunnerInvocation(
  input: Readonly<{
    runner: ConfiguredCustomRunner;
    posture: CustomRunnerSecurityPosture;
    executable: CliExecutableReceipt;
    authorization: AdmittedCustomRunnerInvocation['authorization'];
    scope: CustomRunnerAdmissionScope;
  }>,
): AdmittedCustomRunnerInvocation {
  return {
    kind: 'custom-runner-invocation',
    runner: input.runner,
    posture: input.posture,
    executable: input.executable,
    authorization: input.authorization,
    scope: input.scope,
  };
}

function commandDisplay(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

function hasConfiguredCustomCommand(runner: CustomCommandRunner, config: Config): boolean {
  return findConfiguredCustomCommand(config, runner) !== undefined;
}

function collectCommandRunnerViolations(
  label: string,
  runner: CustomCommandRunner,
  projectDir: string,
): RunnerTrustViolation[] {
  const args = runner.args ?? [];
  const command = commandDisplay(runner.command, args);
  const violations: RunnerTrustViolation[] = [];

  if (commandHasRepoLocalPaths(runner.command, args, projectDir)) {
    violations.push({ label, command });
  }
  if (runner.kind === 'agent' && isShellEvaluatedPromptArg(runner.command, args)) {
    violations.push({ label, command });
  }

  return violations;
}

function commandRunnerViolations(config: Config, projectDir: string): RunnerTrustViolation[] {
  const violations: RunnerTrustViolation[] = [];

  for (const role of ['planner', 'implementer'] as const) {
    const runner = config[role];
    if (!isCustomCommandRunner(runner)) continue;
    if (hasConfiguredCustomCommand(runner, config)) continue;
    violations.push(...collectCommandRunnerViolations(role, runner, projectDir));
  }

  for (const [name, profile] of Object.entries(config.implementerProfiles?.profiles ?? {})) {
    const runner = stripProfileMetadata(profile);
    if (!isCustomCommandRunner(runner)) continue;
    if (hasConfiguredCustomCommand(runner, config)) continue;
    violations.push(
      ...collectCommandRunnerViolations(`implementer profile ${name}`, runner, projectDir),
    );
  }

  return violations;
}

export function checkRunnerTrust(config: Config, projectDir: string): RunnerTrustResult {
  const violations = commandRunnerViolations(config, projectDir);
  return { untrustedCommands: violations.map((violation) => violation.command), violations };
}

export function rejectUntrustedRunners(
  config: Config,
  projectDir: string,
  allowRepoRunners: boolean,
): void {
  const { violations } = checkRunnerTrust(config, projectDir);
  if (violations.length === 0) return;

  if (allowRepoRunners) return;

  const cmds = violations.map((v) => `  ${v.label}: ${v.command}`).join('\n');
  throw error(
    'runner-not-trusted',
    `Refusing to execute untrusted runner commands from project config:\n${cmds}\n` +
      `These commands can execute project-local code or shell-evaluate prompt text. ` +
      `Re-run with --allow-repo-runners to trust them, or use system-installed commands instead.`,
    { commands: violations.map((violation) => violation.command) },
  );
}

export async function resolveCustomRunnerLaunchability(
  options: ResolveCustomRunnerLaunchabilityOptions,
): Promise<CustomRunnerLaunchability> {
  const runner = parseConfiguredCustomRunner(options.runner);
  if (runner === null) return { kind: 'invalid' };
  const trust = await readCustomRunnerTrust({
    projectDir: options.projectDir,
    runner,
    posture: options.posture,
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
  });
  if (trust.kind === 'invalid') return { kind: 'invalid' };

  const resolveExecutable = options.resolveExecutable ?? resolveCustomExecutable;
  const resolution = await resolveExecutable({
    command: runner.command.executable,
    projectDir: options.projectDir,
    ...(trust.kind === 'match' ? { expected: trust.receipt.executable } : {}),
    ...(options.pathEnv === undefined ? {} : { pathEnv: options.pathEnv }),
    ...(options.pathExt === undefined ? {} : { pathExt: options.pathExt }),
  });
  if (resolution.kind === 'identity-drifted') return { kind: 'drifted' };
  if (resolution.kind !== 'resolved') return resolution;
  const disclosure = buildCustomRunnerDisclosure({
    runner,
    posture: options.posture,
    executable: resolution.executable,
  });
  if (disclosure === null) return { kind: 'invalid' };
  if (trust.kind === 'match') {
    return {
      kind: 'trusted',
      executable: resolution.executable,
      disclosure,
      receipt: trust.receipt,
    };
  }
  if (trust.kind === 'stale') {
    return { kind: 'untrusted', executable: resolution.executable, disclosure };
  }
  return { kind: 'resolved', executable: resolution.executable, disclosure };
}

export async function admitCustomRunner(
  options: AdmitCustomRunnerOptions,
): Promise<CustomRunnerAdmission> {
  const runner = parseConfiguredCustomRunner(options.runner);
  const posture = parseCustomRunnerSecurityPosture(options.posture);
  if (runner === null || posture === null) return { kind: 'denied', status: 'invalid' };
  const scope = await resolveCustomRunnerAdmissionScope({
    projectDir: options.projectDir,
    runner,
    posture,
  });
  if (scope === null) return { kind: 'denied', status: 'invalid' };
  const launchability = await resolveCustomRunnerLaunchability(options);
  if (launchability.kind === 'trusted') {
    return {
      kind: 'admitted',
      invocation: createAdmittedCustomRunnerInvocation({
        runner,
        posture,
        executable: launchability.executable,
        authorization: 'receipt',
        scope,
      }),
    };
  }
  if (launchability.kind === 'resolved' || launchability.kind === 'untrusted') {
    if (options.grant) {
      return {
        kind: 'admitted',
        invocation: createAdmittedCustomRunnerInvocation({
          runner,
          posture,
          executable: launchability.executable,
          authorization: 'explicit-grant',
          scope,
        }),
      };
    }
    if (options.interaction === 'interactive') {
      return { kind: 'disclosure-required', disclosure: launchability.disclosure };
    }
  }
  return { kind: 'denied', status: launchability.kind };
}

/**
 * Rechecks an admitted invocation in the authorization context immediately
 * before a child starts. A stage cwd is intentionally not part of this
 * authority check and must remain invisible to the child command contract.
 */
export async function revalidateCustomRunnerInvocation(
  options: RevalidateCustomRunnerInvocationOptions,
): Promise<CliExecutableReceipt> {
  const invocation = parseAdmittedCustomRunnerInvocation(options.invocation);
  if (invocation === null) {
    throw customRunnerAdmissionError.invalid();
  }
  const currentScope = await resolveCustomRunnerAdmissionScope({
    projectDir: options.projectDir,
    runner: invocation.runner,
    posture: invocation.posture,
  });
  if (currentScope === null || !admissionScopesEqual(invocation.scope, currentScope)) {
    throw customRunnerAdmissionError.scopeMismatch();
  }

  const identity = await revalidateCliExecutableIdentity(invocation.executable);
  if (identity === 'missing') {
    throw customRunnerAdmissionError.executableMissing();
  }
  if (identity !== 'match') {
    throw customRunnerAdmissionError.executableDrifted();
  }

  const resolution = await resolveCustomExecutable({
    command: invocation.runner.command.executable,
    projectDir: options.projectDir,
    expected: invocation.executable,
    ...(options.pathEnv === undefined ? {} : { pathEnv: options.pathEnv }),
    ...(options.pathExt === undefined ? {} : { pathExt: options.pathExt }),
  });
  if (resolution.kind !== 'resolved') {
    throw customRunnerAdmissionError.executableResolutionDrifted();
  }
  return resolution.executable;
}
