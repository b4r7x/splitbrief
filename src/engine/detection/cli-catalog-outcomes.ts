import { cloneDetectedModel } from '../../core/discovery/clone-model.js';
import { CliExecutableReceiptSchema, type DetectedModel } from '../../core/discovery/detection.js';
import type { ProbeOutcome, ProbeOutcomeKind } from '../../core/discovery/runner-evidence.js';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';

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

export interface ScopedCliCatalogRuntime {
  readonly connection: ScopedCliCatalogConnection;
  readonly state: ScopedCliCatalogRuntimeState;
  readonly models: readonly DetectedModel[] | null;
  readonly fetchedAt: number | null;
  readonly validatedAt: number;
  readonly failure?: Exclude<ProbeOutcomeKind, 'success'> | undefined;
}

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
    runnerContextKey: string;
    /** Parsed as a rich receipt at this privacy boundary; legacy identities never qualify. */
    executable?: unknown;
  }>,
): ScopedCliCatalogConnection {
  const executableToken =
    input.executable === undefined ? undefined : opaqueExecutableToken(input.executable);
  return {
    tool: input.tool,
    contextKey: `${input.runnerContextKey}|${executableToken ?? 'cli-executable-unresolved'}`,
  };
}

export function scopedCliCatalogToolKey(
  connection: Pick<ScopedCliCatalogConnection, 'tool'>,
): string {
  return connection.tool;
}

export function scopedCliCatalogConnectionKey(connection: ScopedCliCatalogConnection): string {
  return `${scopedCliCatalogToolKey(connection)}\u0000${connection.contextKey}`;
}

function cloneConnection(connection: ScopedCliCatalogConnection): ScopedCliCatalogConnection {
  return { ...connection };
}

function cloneOutcome(
  outcome: ProbeOutcome<readonly DetectedModel[]>,
): ProbeOutcome<readonly DetectedModel[]> {
  return outcome.kind === 'success'
    ? { kind: 'success', value: outcome.value.map(cloneDetectedModel) }
    : { kind: outcome.kind };
}

export function cloneScopedCliCatalogAttempt(
  attempt: ScopedCliCatalogAttempt,
): ScopedCliCatalogAttempt {
  return {
    connection: cloneConnection(attempt.connection),
    outcome: cloneOutcome(attempt.outcome),
  };
}

export function cloneScopedCliCatalogRuntime(
  runtime: ScopedCliCatalogRuntime,
): ScopedCliCatalogRuntime {
  return {
    connection: cloneConnection(runtime.connection),
    state: runtime.state,
    models: runtime.models === null ? null : runtime.models.map(cloneDetectedModel),
    fetchedAt: runtime.fetchedAt,
    validatedAt: runtime.validatedAt,
    ...(runtime.failure === undefined ? {} : { failure: runtime.failure }),
  };
}

function freshRuntime(
  connection: ScopedCliCatalogConnection,
  outcome: Extract<ProbeOutcome<readonly DetectedModel[]>, { kind: 'success' }>,
  observedAt: number,
): ScopedCliCatalogRuntime {
  return {
    connection: cloneConnection(connection),
    state: 'fresh',
    models: outcome.value.map(cloneDetectedModel),
    fetchedAt: observedAt,
    validatedAt: observedAt,
  };
}

function failedRuntime(
  connection: ScopedCliCatalogConnection,
  outcome: Exclude<ProbeOutcome<readonly DetectedModel[]>, { kind: 'success' }>,
  previous: ScopedCliCatalogRuntime | undefined,
  observedAt: number,
): ScopedCliCatalogRuntime {
  if (previous !== undefined && previous.state !== 'failed') {
    return {
      connection: cloneConnection(connection),
      state: 'stale',
      models: previous.models === null ? null : previous.models.map(cloneDetectedModel),
      fetchedAt: previous.fetchedAt,
      validatedAt: observedAt,
      failure: outcome.kind,
    };
  }
  return {
    connection: cloneConnection(connection),
    state: 'failed',
    models: null,
    fetchedAt: null,
    validatedAt: observedAt,
    failure: outcome.kind,
  };
}

/**
 * Reconciles each full tool/context connection independently. A failure
 * can retain only that exact connection's earlier models; a valid empty
 * success is therefore authoritative for exactly one connection.
 */
export function reconcileScopedCliCatalogAttempts(
  input: Readonly<{
    previous: readonly ScopedCliCatalogRuntime[];
    attempts: readonly ScopedCliCatalogAttempt[];
    observedAt: number;
  }>,
): ScopedCliCatalogRuntime[] {
  const observedToolKeys = new Set(
    input.attempts.map((attempt) => scopedCliCatalogToolKey(attempt.connection)),
  );
  const observedConnectionKeys = new Set(
    input.attempts.map((attempt) => scopedCliCatalogConnectionKey(attempt.connection)),
  );
  const previousByConnection = new Map(
    input.previous.map((runtime) => [scopedCliCatalogConnectionKey(runtime.connection), runtime]),
  );
  const next = new Map(
    input.previous
      .filter((runtime) => {
        const toolKey = scopedCliCatalogToolKey(runtime.connection);
        return (
          !observedToolKeys.has(toolKey) ||
          observedConnectionKeys.has(scopedCliCatalogConnectionKey(runtime.connection))
        );
      })
      .map((runtime) => [
        scopedCliCatalogConnectionKey(runtime.connection),
        cloneScopedCliCatalogRuntime(runtime),
      ]),
  );

  for (const attempt of input.attempts) {
    const key = scopedCliCatalogConnectionKey(attempt.connection);
    next.set(
      key,
      attempt.outcome.kind === 'success'
        ? freshRuntime(attempt.connection, attempt.outcome, input.observedAt)
        : failedRuntime(
            attempt.connection,
            attempt.outcome,
            previousByConnection.get(key),
            input.observedAt,
          ),
    );
  }
  return [...next.values()].map(cloneScopedCliCatalogRuntime);
}

/** Returns null for both no entry and an ambiguous lookup across two executables. */
export function findCliCatalogRuntime(
  runtimes: readonly ScopedCliCatalogRuntime[],
  tool: CliToolId,
): ScopedCliCatalogRuntime | null {
  const matches = runtimes.filter((runtime) => runtime.connection.tool === tool);
  return matches.length === 1 && matches[0] !== undefined
    ? cloneScopedCliCatalogRuntime(matches[0])
    : null;
}
