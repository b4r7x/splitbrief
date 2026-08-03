import type { ActiveRunnerRole } from '../../core/config/accessors/active-runner.js';
import { cloneDetectedModel } from '../../core/discovery/clone-model.js';
import { CliExecutableReceiptSchema, type DetectedModel } from '../../core/discovery/detection.js';
import type { ProbeOutcome, ProbeOutcomeKind } from '../../core/discovery/runner-evidence.js';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';

/**
 * A catalog belongs to a single selected runner, not merely to a CLI name.
 * `contextKey` is opaque: the executable receipt stays in this module's
 * process-local token table and is never returned, logged, or persisted.
 */
export interface ScopedCliCatalogConnection {
  readonly role: ActiveRunnerRole;
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
    role: ActiveRunnerRole;
    tool: CliToolId;
    runnerContextKey: string;
    /** Parsed as a rich receipt at this privacy boundary; legacy identities never qualify. */
    executable?: unknown;
  }>,
): ScopedCliCatalogConnection {
  const executableToken =
    input.executable === undefined ? undefined : opaqueExecutableToken(input.executable);
  return {
    role: input.role,
    tool: input.tool,
    contextKey: `${input.runnerContextKey}|${executableToken ?? 'cli-executable-unresolved'}`,
  };
}

export function scopedCliCatalogRoleKey(
  connection: Pick<ScopedCliCatalogConnection, 'role' | 'tool'>,
): string {
  return `${connection.role}\u0000${connection.tool}`;
}

export function scopedCliCatalogConnectionKey(connection: ScopedCliCatalogConnection): string {
  return `${scopedCliCatalogRoleKey(connection)}\u0000${connection.contextKey}`;
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

function failedRuntime(
  attempt: ScopedCliCatalogAttempt,
  previous: ScopedCliCatalogRuntime | undefined,
  observedAt: number,
): ScopedCliCatalogRuntime {
  if (attempt.outcome.kind === 'success') {
    return {
      connection: cloneConnection(attempt.connection),
      state: 'fresh',
      models: attempt.outcome.value.map(cloneDetectedModel),
      fetchedAt: observedAt,
      validatedAt: observedAt,
    };
  }
  if (previous !== undefined && previous.state !== 'failed') {
    return {
      connection: cloneConnection(attempt.connection),
      state: 'stale',
      models: previous.models === null ? null : previous.models.map(cloneDetectedModel),
      fetchedAt: previous.fetchedAt,
      validatedAt: observedAt,
      failure: attempt.outcome.kind,
    };
  }
  return {
    connection: cloneConnection(attempt.connection),
    state: 'failed',
    models: null,
    fetchedAt: null,
    validatedAt: observedAt,
    failure: attempt.outcome.kind,
  };
}

/**
 * Reconciles each full role/tool/context connection independently. A failure
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
  const observedRoleKeys = new Set(
    input.attempts.map((attempt) => scopedCliCatalogRoleKey(attempt.connection)),
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
        const roleKey = scopedCliCatalogRoleKey(runtime.connection);
        return (
          !observedRoleKeys.has(roleKey) ||
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
    next.set(key, failedRuntime(attempt, previousByConnection.get(key), input.observedAt));
  }
  return [...next.values()].map(cloneScopedCliCatalogRuntime);
}

/** Returns null for both no exact entry and an ambiguous generic lookup. */
export function findScopedCliCatalogRuntime(
  runtimes: readonly ScopedCliCatalogRuntime[],
  connection: Pick<ScopedCliCatalogConnection, 'role' | 'tool'>,
): ScopedCliCatalogRuntime | null {
  const roleKey = scopedCliCatalogRoleKey(connection);
  const matches = runtimes.filter(
    (runtime) => scopedCliCatalogRoleKey(runtime.connection) === roleKey,
  );
  return matches.length === 1 && matches[0] !== undefined
    ? cloneScopedCliCatalogRuntime(matches[0])
    : null;
}

/** Generic tool lookup is valid only when there is exactly one unambiguous row. */
export function findGenericCliCatalogRuntime(
  runtimes: readonly ScopedCliCatalogRuntime[],
  tool: CliToolId,
): ScopedCliCatalogRuntime | null {
  const matches = runtimes.filter((runtime) => runtime.connection.tool === tool);
  return matches.length === 1 && matches[0] !== undefined
    ? cloneScopedCliCatalogRuntime(matches[0])
    : null;
}
