import { z } from 'zod';
import { CustomCommandIdSchema } from '../../../core/config/custom-commands/schema.js';
import { CliExecutableReceiptSchema } from '../../../core/discovery/detection/executable.js';
import {
  TRUST_STORE_MAX_RECEIPTS,
  resolveTrustStorePath,
  trustedProjectIdentity,
  readTrustStore,
} from '../../../core/trust/receipt-store.js';
import { writeSecureFileAsync } from '../../../lib/fs/secure.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { sha256Hex } from '../../../utils/sha256.js';
import {
  DigestSchema,
  type CustomRunnerAdmissionScope,
  type ConfiguredCustomRunner,
  type CustomRunnerSecurityPosture,
  ConfiguredCustomRunnerSchema,
  CustomRunnerSecurityPostureSchema,
  postureDescribesRunner,
} from './posture.js';

const CUSTOM_RUNNER_TRUST_VERSION = 1;
const CUSTOM_RUNNER_TRUST_FILE = 'custom-runners.json';

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

const CustomRunnerTrustFileSchema = z
  .strictObject({
    version: z.literal(CUSTOM_RUNNER_TRUST_VERSION),
    receipts: z.array(CustomRunnerTrustReceiptSchema).max(TRUST_STORE_MAX_RECEIPTS),
  })
  .readonly();
export type CustomRunnerTrustReceipt = z.infer<typeof CustomRunnerTrustReceiptSchema>;

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

type TrustScope = CustomRunnerAdmissionScope &
  Readonly<{
    runner: ConfiguredCustomRunner;
    posture: CustomRunnerSecurityPosture;
  }>;

type TrustFileRead =
  | Readonly<{ kind: 'missing'; value: z.infer<typeof CustomRunnerTrustFileSchema> }>
  | Readonly<{ kind: 'value'; value: z.infer<typeof CustomRunnerTrustFileSchema> }>
  | Readonly<{ kind: 'invalid' }>;

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
