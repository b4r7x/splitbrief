import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CustomCommandIdSchema,
  NormalizedCustomCommandSchema,
  type CustomCommandContract,
} from '../../core/config/custom-commands.js';
import { CliExecutableReceiptSchema } from '../../core/discovery/detection.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import { writeSecureFileAsync } from '../../lib/fs.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { sha256Hex } from '../../utils/sha256.js';
import { assertNever } from '../../utils/type-guards.js';

const CUSTOM_RUNNER_TRUST_VERSION = 1;
const CUSTOM_RUNNER_TRUST_DIRECTORY = 'trust';
const CUSTOM_RUNNER_TRUST_FILE = 'custom-runners.json';
const CUSTOM_RUNNER_TRUST_MAX_BYTES = 256 * 1024;
const CUSTOM_RUNNER_TRUST_MAX_RECEIPTS = 512;

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const CustomRunnerSecurityPostureSchema = z
  .strictObject({
    role: z.enum(['planner', 'implementer']),
    cwd: z.literal('disposable-stage'),
    stage: z.literal('filtered-disposable-stage'),
    filesystem: z.literal('host-user-access'),
    network: z.literal('host-network-access'),
    result: z.enum([
      'parsed-output-only',
      'reviewed-declared-artifact-or-workspace-diff-only',
      'reviewed-diff-only',
    ]),
  })
  .readonly();

const ConfiguredCustomRunnerSchema = z
  .strictObject({
    source: z.literal('configured'),
    command: NormalizedCustomCommandSchema,
  })
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
    receipts: z.array(CustomRunnerTrustReceiptSchema).max(CUSTOM_RUNNER_TRUST_MAX_RECEIPTS),
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
  | Readonly<{ kind: 'trusted'; receipt: CustomRunnerTrustReceipt }>
  | Readonly<{ kind: 'invalid' }>;

export type CustomRunnerDisclosure = Readonly<{
  executable: string;
  argv: readonly string[];
  contract: CustomCommandContract;
  cwd: 'Disposable staged project';
  stage: 'Filtered disposable stage';
  environment: readonly string[];
  filesystem: 'Not an OS sandbox; the process can access files available to the current user';
  network: 'Network access is not restricted';
  result:
    | 'Parsed output only; stage-local writes are discarded'
    | 'Reviewed declared artifact for normal planner calls; reviewed workspace diff for full escalation only'
    | 'Reviewed diff only';
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

const CUSTOM_RUNNER_RESULT_BY_ROLE_AND_CONTRACT = {
  planner: {
    output: 'parsed-output-only',
    direct: 'reviewed-declared-artifact-or-workspace-diff-only',
  },
  implementer: {
    output: 'parsed-output-only',
    direct: 'reviewed-diff-only',
  },
} as const;

function canonicalCustomRunnerResult(
  role: CustomRunnerSecurityPosture['role'],
  contract: CustomCommandContract,
): CustomRunnerSecurityPosture['result'] {
  return CUSTOM_RUNNER_RESULT_BY_ROLE_AND_CONTRACT[role][contract];
}

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
    default:
      return assertNever(result);
  }
}

export function customRunnerSecurityPosture(
  role: CustomRunnerSecurityPosture['role'],
  contract: CustomCommandContract,
): CustomRunnerSecurityPosture {
  return {
    role,
    cwd: 'disposable-stage',
    stage: 'filtered-disposable-stage',
    filesystem: 'host-user-access',
    network: 'host-network-access',
    result: canonicalCustomRunnerResult(role, contract),
  };
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
  const root = stateDir ?? join(homedir(), SPLITBRIEF_DIR, CUSTOM_RUNNER_TRUST_DIRECTORY);
  return join(root, CUSTOM_RUNNER_TRUST_FILE);
}

function emptyTrustFile(): z.infer<typeof CustomRunnerTrustFileSchema> {
  return { version: CUSTOM_RUNNER_TRUST_VERSION, receipts: [] };
}

async function projectIdentity(projectDir: string): Promise<string | null> {
  try {
    const canonicalProject = await realpath(projectDir);
    return `sha256:${sha256Hex(canonicalProject)}`;
  } catch {
    return null;
  }
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
  const expectedResult = canonicalCustomRunnerResult(
    posture.data.role,
    runner.data.command.contract,
  );
  if (posture.data.result !== expectedResult) return null;
  const identity = await projectIdentity(input.projectDir);
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

async function readTrustFile(path: string): Promise<TrustFileRead> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) ||
      !Number.isSafeInteger(stats.size) ||
      stats.size < 0 ||
      stats.size > CUSTOM_RUNNER_TRUST_MAX_BYTES
    ) {
      return { kind: 'invalid' };
    }
    const parsed = CustomRunnerTrustFileSchema.safeParse(JSON.parse(await handle.readFile('utf8')));
    return parsed.success ? { kind: 'value', value: parsed.data } : { kind: 'invalid' };
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
      return { kind: 'missing', value: emptyTrustFile() };
    }
    return { kind: 'invalid' };
  } finally {
    await handle?.close();
  }
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
  const file = await readTrustFile(resolveCustomRunnerTrustFile(input.stateDir));
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
  }>,
): Promise<MarkCustomRunnerTrustedResult> {
  const scope = await trustScope(input);
  const executable = CliExecutableReceiptSchema.safeParse(input.executable);
  if (scope === null || !executable.success) return { kind: 'invalid' };

  const path = resolveCustomRunnerTrustFile(input.stateDir);
  const file = await readTrustFile(path);
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
  const receipts = [...otherReceipts, receipt].slice(-CUSTOM_RUNNER_TRUST_MAX_RECEIPTS);
  await writeSecureFileAsync(
    path,
    `${JSON.stringify({ version: CUSTOM_RUNNER_TRUST_VERSION, receipts }, null, 2)}\n`,
  );
  return { kind: 'trusted', receipt };
}

export function escapeCustomRunnerLiteral(value: string): string {
  const json = JSON.stringify(value);
  return json.replace(
    /[\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    (character) => {
      const code = character.codePointAt(0) ?? 0;
      return `\\u${code.toString(16).padStart(4, '0')}`;
    },
  );
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
  const expectedResult = canonicalCustomRunnerResult(
    posture.data.role,
    runner.data.command.contract,
  );
  if (posture.data.result !== expectedResult) return null;
  return {
    executable: escapeCustomRunnerLiteral(executable.data.path),
    argv: runner.data.command.argv.map(escapeCustomRunnerLiteral),
    contract: runner.data.command.contract,
    cwd: 'Disposable staged project',
    stage: 'Filtered disposable stage',
    environment: runner.data.command.env.map(escapeCustomRunnerLiteral),
    filesystem: 'Not an OS sandbox; the process can access files available to the current user',
    network: 'Network access is not restricted',
    result: disclosureResult(expectedResult),
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
    `Filesystem: ${disclosure.filesystem}`,
    `Network: ${disclosure.network}`,
    `Result: ${disclosure.result}`,
  ].join('\n');
}
