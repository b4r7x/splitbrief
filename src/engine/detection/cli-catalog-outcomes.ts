import { cloneDetectedModel } from '../../core/discovery/clone-model.js';
import { CliExecutableReceiptSchema, type DetectedModel } from '../../core/discovery/detection.js';
import type { ProbeOutcome, ProbeOutcomeKind } from '../../core/discovery/runner-evidence.js';
import type { CliAuthChannelId, CliToolId } from '../../core/runners/cli-tool-catalog.js';

/**
 * A catalog belongs to one CLI executable, not to a seat.
 * `contextKey` is opaque: the executable receipt stays in this module's
 * process-local token table and is never returned, logged, or persisted.
 */
export interface ScopedCliCatalogConnection {
  readonly tool: CliToolId;
  readonly contextKey: string;
}

export interface ScopedCliCatalogAttempt {
  readonly connection: ScopedCliCatalogConnection;
  readonly outcome: ProbeOutcome<readonly DetectedModel[]>;
}

export type ScopedCliCatalogRuntimeState = 'fresh' | 'stale' | 'failed';

export type ScopedCliCatalogRuntime = Readonly<{
  connection: ScopedCliCatalogConnection;
  state: ScopedCliCatalogRuntimeState;
  models: readonly DetectedModel[] | null;
  missingOnce?: readonly string[] | undefined;
  fetchedAt: number | null;
  validatedAt: number;
}> &
  (
    | Readonly<{ failure: 'command-failed'; failureCause: string }>
    | Readonly<{
        failure?: Exclude<ProbeOutcomeKind, 'success' | 'command-failed'> | undefined;
        failureCause?: never | undefined;
      }>
  );

const executableTokens = new Map<string, string>();
let nextExecutableToken = 1;
const MAX_OPAQUE_EXECUTABLE_TOKENS = 256;

function opaqueExecutableToken(executable: unknown): string | null {
  const parsed = CliExecutableReceiptSchema.safeParse(executable);
  if (!parsed.success) return null;
  const receipt = parsed.data.executableIdentity;
  const identity = `${receipt.canonicalPath}\u0000${receipt.realPath}\u0000${receipt.platformFileId}\u0000${receipt.fingerprint}`;
  const existing = executableTokens.get(identity);
  if (existing !== undefined) return existing;
  const token = `cli-executable-${nextExecutableToken}`;
  nextExecutableToken += 1;
  executableTokens.set(identity, token);
  while (executableTokens.size > MAX_OPAQUE_EXECUTABLE_TOKENS) {
    const oldest = executableTokens.keys().next().value;
    if (oldest === undefined) break;
    executableTokens.delete(oldest);
  }
  return token;
}

/**
 * Adds a process-local exact-executable binding without disclosing a path,
 * fingerprint, digest, credential, or credential-derived value to consumers.
 */
export function scopedCliCatalogConnection(
  input: Readonly<{
    tool: CliToolId;
    authChannel: CliAuthChannelId | undefined;
    /** Parsed as a rich receipt at this privacy boundary; legacy identities never qualify. */
    executable?: unknown;
  }>,
): ScopedCliCatalogConnection {
  const executableToken =
    input.executable === undefined ? undefined : opaqueExecutableToken(input.executable);
  return {
    tool: input.tool,
    contextKey: [
      'cli-catalog-v1',
      input.tool,
      input.authChannel ?? 'not-selected',
      executableToken ?? 'cli-executable-unresolved',
    ].join('|'),
  };
}

function cloneConnection(connection: ScopedCliCatalogConnection): ScopedCliCatalogConnection {
  return { ...connection };
}

function cloneOutcome(
  outcome: ProbeOutcome<readonly DetectedModel[]>,
): ProbeOutcome<readonly DetectedModel[]> {
  return outcome.kind === 'success'
    ? { kind: 'success', value: outcome.value.map(cloneDetectedModel) }
    : { ...outcome };
}

export function cloneScopedCliCatalogAttempt(
  attempt: ScopedCliCatalogAttempt,
): ScopedCliCatalogAttempt {
  return {
    connection: cloneConnection(attempt.connection),
    outcome: cloneOutcome(attempt.outcome),
  };
}
