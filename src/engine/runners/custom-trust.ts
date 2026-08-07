import { z } from 'zod';
import {
  CustomCommandIdSchema,
  InlineRunnerCommandSchema,
  NormalizedCustomCommandSchema,
  type CustomCommandContract,
} from '../../core/config/custom-commands.js';
import { CliExecutableReceiptSchema } from '../../core/discovery/detection.js';
import { escapeTrustLiteral } from '../../core/trust/literal.js';
import {
  TRUST_STORE_MAX_RECEIPTS,
  readTrustStore,
  resolveTrustStorePath,
  trustedProjectIdentity,
} from '../../core/trust/receipt-store.js';
import { writeSecureFileAsync } from '../../lib/fs.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { sha256Hex } from '../../utils/sha256.js';
import { assertNever } from '../../utils/type-guards.js';
import { throwIfAborted } from '../../utils/abort.js';

const CUSTOM_RUNNER_TRUST_VERSION = 1;
const CUSTOM_RUNNER_TRUST_FILE = 'custom-runners.json';

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const CustomRunnerSecurityPostureSchema = z
  .strictObject({
    role: z.enum(['planner', 'implementer']),
    source: z.enum(['configured', 'inline']),
    cwd: z.enum(['disposable-stage', 'project-directory']),
    stage: z.enum(['filtered-disposable-stage', 'none']),
    environmentAccess: z.enum(['declared-references-only', 'inherited-process-environment']),
    filesystem: z.literal('host-user-access'),
    network: z.literal('host-network-access'),
    result: z.enum([
      'parsed-output-only',
      'reviewed-declared-artifact-or-workspace-diff-only',
      'reviewed-diff-only',
      'inline-parsed-output-only',
      'inline-workspace-writes',
    ]),
  })
  .readonly();

const ConfiguredCustomRunnerSchema = z
  .discriminatedUnion('source', [
    z.strictObject({
      source: z.literal('configured'),
      command: NormalizedCustomCommandSchema,
    }),
    z.strictObject({
      source: z.literal('inline'),
      command: InlineRunnerCommandSchema,
    }),
  ])
  .readonly();

const CustomRunnerTrustReceiptSchema = z
  .strictObject({
    version: z.literal(CUSTOM_RUNNER_TRUST_VERSION),
    projectIdentity: DigestSchema,
    definitionId: CustomCommandIdSchema,
    definitionDigest: DigestSchema,
    executable: CliExecutableReceiptSchema,
    trustedAt: z.number().finite().nonnegative(),
  })
  .readonly();

const CustomRunnerAdmissionScopeSchema = z
  .strictObject({
    projectIdentity: DigestSchema,
    definitionId: CustomCommandIdSchema,
    definitionDigest: DigestSchema,
  })
  .readonly();

const CustomRunnerTrustFileSchema = z
  .strictObject({
    version: z.literal(CUSTOM_RUNNER_TRUST_VERSION),
    receipts: z.array(CustomRunnerTrustReceiptSchema).max(TRUST_STORE_MAX_RECEIPTS),
  })
  .readonly();

export type ConfiguredCustomRunner = z.infer<typeof ConfiguredCustomRunnerSchema>;

export type CustomRunnerSecurityPosture = z.infer<typeof CustomRunnerSecurityPostureSchema>;
export type CustomRunnerTrustReceipt = z.infer<typeof CustomRunnerTrustReceiptSchema>;
export type CustomRunnerAdmissionScope = z.infer<typeof CustomRunnerAdmissionScopeSchema>;

export type CustomRunnerTrustLookup =
  | Readonly<{ kind: 'match'; receipt: CustomRunnerTrustReceipt }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'stale' }>
  | Readonly<{ kind: 'invalid' }>;

export type MarkCustomRunnerTrustedResult =
  | Readonly<{
      kind: 'trusted';
      receipt: CustomRunnerTrustReceipt;
      abortedAfterPublication: boolean;
    }>
  | Readonly<{ kind: 'invalid' }>;

export type CustomRunnerDisclosure = Readonly<{
  executable: string;
  argv: readonly string[];
  contract: CustomCommandContract;
  cwd: 'Disposable staged project' | 'Project directory';
  stage: 'Filtered disposable stage' | 'None';
  environment: readonly string[];
  environmentAccess:
    | 'Declared environment references only'
    | 'Inherits the full SPLITBRIEF process environment, including credentials';
  filesystem: 'Not an OS sandbox; the process can access files available to the current user';
  network: 'Network access is not restricted';
  result:
    | 'Parsed output only; stage-local writes are discarded'
    | 'Reviewed declared artifact for normal planner calls; reviewed workspace diff for full escalation only'
    | 'Reviewed diff only'
    | 'Parsed stdout only; anything it writes in the project is neither staged nor reviewed'
    | 'Reviewed workspace diff; it writes directly into the project directory';
}>;

type TrustScope = CustomRunnerAdmissionScope &
  Readonly<{
    runner: ConfiguredCustomRunner;
    posture: CustomRunnerSecurityPosture;
  }>;

type TrustFileRead =
  | Readonly<{ kind: 'missing'; value: z.infer<typeof CustomRunnerTrustFileSchema> }>
  | Readonly<{ kind: 'value'; value: z.infer<typeof CustomRunnerTrustFileSchema> }>
  | Readonly<{ kind: 'invalid' }>;

const CONFIGURED_RESULT_BY_ROLE_AND_CONTRACT = {
  planner: {
    output: 'parsed-output-only',
    direct: 'reviewed-declared-artifact-or-workspace-diff-only',
  },
  implementer: {
    output: 'parsed-output-only',
    direct: 'reviewed-diff-only',
  },
} as const;

const INLINE_RESULT_BY_CONTRACT = {
  output: 'inline-parsed-output-only',
  direct: 'inline-workspace-writes',
} as const;

function disclosureResult(
  result: CustomRunnerSecurityPosture['result'],
): CustomRunnerDisclosure['result'] {
  switch (result) {
    case 'parsed-output-only':
      return 'Parsed output only; stage-local writes are discarded';
    case 'reviewed-declared-artifact-or-workspace-diff-only':
      return 'Reviewed declared artifact for normal planner calls; reviewed workspace diff for full escalation only';
    case 'reviewed-diff-only':
      return 'Reviewed diff only';
    case 'inline-parsed-output-only':
      return 'Parsed stdout only; anything it writes in the project is neither staged nor reviewed';
    case 'inline-workspace-writes':
      return 'Reviewed workspace diff; it writes directly into the project directory';
    default:
      return assertNever(result);
  }
}

function canonicalPosture(
  input: Readonly<{
    source: CustomRunnerSecurityPosture['source'];
    role: CustomRunnerSecurityPosture['role'];
    contract: CustomCommandContract;
  }>,
): CustomRunnerSecurityPosture {
  const common = {
    role: input.role,
    filesystem: 'host-user-access',
    network: 'host-network-access',
  } as const;
  return input.source === 'configured'
    ? {
        ...common,
        source: 'configured',
        cwd: 'disposable-stage',
        stage: 'filtered-disposable-stage',
        environmentAccess: 'declared-references-only',
        result: CONFIGURED_RESULT_BY_ROLE_AND_CONTRACT[input.role][input.contract],
      }
    : {
        ...common,
        source: 'inline',
        cwd: 'project-directory',
        stage: 'none',
        environmentAccess: 'inherited-process-environment',
        result: INLINE_RESULT_BY_CONTRACT[input.contract],
      };
}

/** Posture of a `customCommands` entry: staged cwd, declared environment only. */
export function customRunnerSecurityPosture(
  role: CustomRunnerSecurityPosture['role'],
  contract: CustomCommandContract,
): CustomRunnerSecurityPosture {
  return canonicalPosture({ source: 'configured', role, contract });
}

/**
 * Posture of a runner declared inline in `planner`/`implementer`: it runs in
 * the project directory and inherits this process's environment, so the
 * disclosure the owner confirms must say so.
 */
export function inlineRunnerSecurityPosture(
  role: CustomRunnerSecurityPosture['role'],
  contract: CustomCommandContract,
): CustomRunnerSecurityPosture {
  return canonicalPosture({ source: 'inline', role, contract });
}

/**
 * The posture is what the owner is asked to accept, so it must be the exact
 * canonical description of how this runner is executed — not merely a posture
 * whose result field happens to line up.
 */
function postureDescribesRunner(
  posture: CustomRunnerSecurityPosture,
  runner: ConfiguredCustomRunner,
): boolean {
  return (
    canonicalJSON(posture) ===
    canonicalJSON(
      canonicalPosture({
        source: runner.source,
        role: posture.role,
        contract: runner.command.contract,
      }),
    )
  );
}

export function parseConfiguredCustomRunner(input: unknown): ConfiguredCustomRunner | null {
  const parsed = ConfiguredCustomRunnerSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseCustomRunnerSecurityPosture(
  input: unknown,
): CustomRunnerSecurityPosture | null {
  const parsed = CustomRunnerSecurityPostureSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseCustomRunnerAdmissionScope(input: unknown): CustomRunnerAdmissionScope | null {
  const parsed = CustomRunnerAdmissionScopeSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function resolveCustomRunnerTrustFile(stateDir?: string): string {
  return resolveTrustStorePath(CUSTOM_RUNNER_TRUST_FILE, stateDir);
}

function emptyTrustFile(): z.infer<typeof CustomRunnerTrustFileSchema> {
  return { version: CUSTOM_RUNNER_TRUST_VERSION, receipts: [] };
}

function definitionDigest(
  runner: ConfiguredCustomRunner,
  posture: CustomRunnerSecurityPosture,
): string {
  return `sha256:${sha256Hex(canonicalJSON({ command: runner.command, posture }))}`;
}

async function trustScope(
  input: Readonly<{
    projectDir: string;
    runner: unknown;
    posture: unknown;
  }>,
): Promise<TrustScope | null> {
  const runner = ConfiguredCustomRunnerSchema.safeParse(input.runner);
  const posture = CustomRunnerSecurityPostureSchema.safeParse(input.posture);
  if (!runner.success || !posture.success) return null;
  if (!postureDescribesRunner(posture.data, runner.data)) return null;
  const identity = trustedProjectIdentity(input.projectDir);
  if (identity === null) return null;
  return {
    projectIdentity: identity,
    definitionId: runner.data.command.id,
    definitionDigest: definitionDigest(runner.data, posture.data),
    runner: runner.data,
    posture: posture.data,
  };
}

/**
 * Resolves the exact canonical scope shared by owner-only receipts and an
 * admitted invocation. Keeping this behind `trustScope` prevents a second
 * definition/project digest contract from drifting away from receipt lookup.
 */
export async function resolveCustomRunnerAdmissionScope(
  input: Readonly<{
    projectDir: string;
    runner: unknown;
    posture: unknown;
  }>,
): Promise<CustomRunnerAdmissionScope | null> {
  const scope = await trustScope(input);
  if (scope === null) return null;
  return {
    projectIdentity: scope.projectIdentity,
    definitionId: scope.definitionId,
    definitionDigest: scope.definitionDigest,
  };
}

function readTrustFile(path: string): TrustFileRead {
  const read = readTrustStore(path, (value) => {
    const parsed = CustomRunnerTrustFileSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  return read.kind === 'missing' ? { kind: 'missing', value: emptyTrustFile() } : read;
}

export async function readCustomRunnerTrust(
  input: Readonly<{
    projectDir: string;
    runner: unknown;
    posture: unknown;
    stateDir?: string | undefined;
  }>,
): Promise<CustomRunnerTrustLookup> {
  const scope = await trustScope(input);
  if (scope === null) return { kind: 'invalid' };
  const file = readTrustFile(resolveCustomRunnerTrustFile(input.stateDir));
  if (file.kind === 'invalid') return { kind: 'invalid' };
  const receipt = file.value.receipts.find(
    (candidate) =>
      candidate.projectIdentity === scope.projectIdentity &&
      candidate.definitionId === scope.definitionId,
  );
  if (receipt === undefined) return { kind: 'none' };
  if (receipt.definitionDigest !== scope.definitionDigest) return { kind: 'stale' };
  return { kind: 'match', receipt };
}

export async function markCustomRunnerTrusted(
  input: Readonly<{
    projectDir: string;
    runner: unknown;
    posture: unknown;
    executable: unknown;
    stateDir?: string | undefined;
    now?: (() => number) | undefined;
    signal?: AbortSignal | undefined;
    _beforeWrite?: (() => void) | undefined;
    _afterWrite?: (() => void) | undefined;
  }>,
): Promise<MarkCustomRunnerTrustedResult> {
  throwIfAborted(input.signal);
  const scope = await trustScope(input);
  throwIfAborted(input.signal);
  const executable = CliExecutableReceiptSchema.safeParse(input.executable);
  if (scope === null || !executable.success) return { kind: 'invalid' };

  const path = resolveCustomRunnerTrustFile(input.stateDir);
  const file = readTrustFile(path);
  throwIfAborted(input.signal);
  if (file.kind === 'invalid') return { kind: 'invalid' };
  const receipt = CustomRunnerTrustReceiptSchema.parse({
    version: CUSTOM_RUNNER_TRUST_VERSION,
    projectIdentity: scope.projectIdentity,
    definitionId: scope.definitionId,
    definitionDigest: scope.definitionDigest,
    executable: executable.data,
    trustedAt: (input.now ?? Date.now)(),
  });
  const otherReceipts = file.value.receipts.filter(
    (candidate) =>
      candidate.projectIdentity !== scope.projectIdentity ||
      candidate.definitionId !== scope.definitionId,
  );
  const receipts = [...otherReceipts, receipt].slice(-TRUST_STORE_MAX_RECEIPTS);
  input._beforeWrite?.();
  throwIfAborted(input.signal);
  await writeSecureFileAsync(
    path,
    `${JSON.stringify({ version: CUSTOM_RUNNER_TRUST_VERSION, receipts }, null, 2)}\n`,
  );
  input._afterWrite?.();
  return {
    kind: 'trusted',
    receipt,
    abortedAfterPublication: input.signal?.aborted === true,
  };
}

export function buildCustomRunnerDisclosure(
  input: Readonly<{
    runner: unknown;
    posture: unknown;
    executable: unknown;
  }>,
): CustomRunnerDisclosure | null {
  const runner = ConfiguredCustomRunnerSchema.safeParse(input.runner);
  const posture = CustomRunnerSecurityPostureSchema.safeParse(input.posture);
  const executable = CliExecutableReceiptSchema.safeParse(input.executable);
  if (!runner.success || !posture.success || !executable.success) return null;
  if (!postureDescribesRunner(posture.data, runner.data)) return null;
  return {
    executable: escapeTrustLiteral(executable.data.path),
    argv: runner.data.command.argv.map(escapeTrustLiteral),
    contract: runner.data.command.contract,
    cwd:
      posture.data.cwd === 'disposable-stage' ? 'Disposable staged project' : 'Project directory',
    stage:
      posture.data.stage === 'filtered-disposable-stage' ? 'Filtered disposable stage' : 'None',
    environment: runner.data.command.env.map(escapeTrustLiteral),
    environmentAccess:
      posture.data.environmentAccess === 'declared-references-only'
        ? 'Declared environment references only'
        : 'Inherits the full SPLITBRIEF process environment, including credentials',
    filesystem: 'Not an OS sandbox; the process can access files available to the current user',
    network: 'Network access is not restricted',
    result: disclosureResult(posture.data.result),
  };
}

export function formatCustomRunnerDisclosure(disclosure: CustomRunnerDisclosure): string {
  return [
    `Executable: ${disclosure.executable}`,
    `Arguments: ${disclosure.argv.length === 0 ? '(none)' : disclosure.argv.join(' ')}`,
    `Contract: ${disclosure.contract}`,
    `Working directory: ${disclosure.cwd}`,
    `Staging: ${disclosure.stage}`,
    `Environment names: ${
      disclosure.environment.length === 0 ? '(none)' : disclosure.environment.join(', ')
    }`,
    `Environment access: ${disclosure.environmentAccess}`,
    `Filesystem: ${disclosure.filesystem}`,
    `Network: ${disclosure.network}`,
    `Result: ${disclosure.result}`,
  ].join('\n');
}
