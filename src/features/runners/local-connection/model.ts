import { parseApiKeyEnvRef } from '../../../core/config/credentials.js';
import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import {
  type ApiProviderId,
  getApiProviderDescriptor,
  type ApiProviderDescriptor,
} from '../../../core/providers/api-catalog.js';
import { normalizeProviderEndpoint } from '../../../core/providers/endpoint-policy.js';
import {
  OLLAMA_LOCAL_API_KEY_REFERENCE,
  isOllamaLocalCredentialReference,
} from '../../../core/providers/ollama-credential.js';
import { type SeatPickerRole, seatPickerLane } from '../../../core/runners/seat-roles.js';
import { SOFT_SEP } from '../../../core/separators.js';
import type { ConfiguredProviderRuntime } from '../../../engine/detection/provider-outcomes.js';
import { deriveProviderConnectionState } from '../../../engine/providers/connection-state.js';
import { apiConnectionContextKey } from '../../../engine/providers/selected-model.js';
import type { ProviderCatalogOutcome } from '../../../engine/providers/types.js';
import type { SlowProbeText } from '../../../hooks/use-slow-probe-text.js';
import type { PickerOption } from '../model-catalog/options.js';

/** The connection the seat configured itself; a review seat never reads the planner's. */
export interface LocalConnectionSeat {
  /** The seat's own address, or the profile default when the seat carries none. */
  readonly apiBase: string;
  /** An `env:NAME` reference, never a secret; absent when the seat carries none. */
  readonly apiKey?: string | undefined;
  /** The exact catalog id the seat selected, tag and quantization included. */
  readonly model?: string | undefined;
}

/** What Check asks the server: an address and an optional token, and nothing else. */
export interface LocalConnectionProbeInput {
  readonly provider: ApiProviderId;
  readonly apiBase: string;
  readonly apiKey?: string | undefined;
  /** Aborts when the form closes or a newer check or edit replaces this one. */
  readonly signal?: AbortSignal | undefined;
}

/** The read-only catalog probe: it lists, and starts, pulls and loads nothing. */
export type LocalConnectionProbe = (
  input: LocalConnectionProbeInput,
) => Promise<ProviderCatalogOutcome>;

export interface LocalConnectionSave {
  readonly provider: ApiProviderId;
  readonly apiBase: string;
  readonly apiKey: string | undefined;
  readonly model: string;
}

/**
 * A local server the picker cannot fill a model column for answers for itself: its row
 * opens this form instead of parking the cursor on a dead end. A server that is
 * answering keeps the model column it already fills.
 */
export function localConnectionProvider(item: PickerOption): ApiProviderId | undefined {
  if (item.kind !== 'api' || item.available) return undefined;
  const descriptor = getApiProviderDescriptor(item.id);
  return descriptor?.offering === 'local' ? descriptor.id : undefined;
}

export interface LocalConnectionModelRow {
  /** The exact id a save writes; never the label. */
  readonly id: string;
  readonly label: string;
  /**
   * What is known about this model on this connection, in one word per row: the server's
   * own load answer where it gives one, and otherwise how far the check got. Nothing is
   * left blank, because a blank would read as a claim.
   */
  readonly state:
    | 'not checked'
    | 'unknown'
    | 'listed'
    | 'loaded'
    | 'not loaded'
    | 'not in this catalog';
}

function listedState(model: DetectedModel): LocalConnectionModelRow['state'] {
  const loadState = model.runtime?.loadState;
  if (loadState === 'loaded') return 'loaded';
  return loadState === 'not-loaded' ? 'not loaded' : 'listed';
}

/**
 * The rows the catalog offers, plus the seat's own selection. A selection this catalog
 * does not carry keeps its row and says so rather than handing the seat the first id the
 * server happened to list.
 */
export function localConnectionModelRows(input: {
  seatModel: string | undefined;
  catalog: readonly DetectedModel[] | undefined;
  /** A check that could not produce a catalog leaves the selection unproven, not absent. */
  probed: boolean;
}): LocalConnectionModelRow[] {
  const { seatModel, catalog } = input;
  if (catalog === undefined) {
    if (seatModel === undefined) return [];
    return [{ id: seatModel, label: seatModel, state: input.probed ? 'unknown' : 'not checked' }];
  }
  const listed = catalog.map(
    (model): LocalConnectionModelRow => ({
      id: model.id,
      label: model.displayName ?? model.id,
      state: listedState(model),
    }),
  );
  if (seatModel === undefined || listed.some((row) => row.id === seatModel)) return listed;
  return [{ id: seatModel, label: seatModel, state: 'not in this catalog' }, ...listed];
}

export type ProbeState =
  | { kind: 'idle' }
  | { kind: 'refused'; message: string }
  | { kind: 'checking'; at: string }
  | { kind: 'failed'; at: string; message: string }
  | { kind: 'done'; at: string; outcome: ProviderCatalogOutcome };

/** The endpoint a result belongs to: a catalog never outlives the address it came from. */
export function contextOf(provider: ApiProviderId, apiBase: string, token: string): string {
  return `${apiConnectionContextKey(provider, apiBase)}|${token === '' ? 'anonymous' : 'token'}`;
}

export function defaultAddress(descriptor: ApiProviderDescriptor): string {
  return descriptor.endpointPolicy.kind === 'loopback'
    ? descriptor.endpointPolicy.defaultBaseURL
    : '';
}

export function normalizeAddress(
  descriptor: ApiProviderDescriptor,
  draft: string,
): { apiBase: string } | { error: string } {
  try {
    return { apiBase: normalizeProviderEndpoint(descriptor.endpointPolicy, draft.trim()) };
  } catch {
    return { error: `Address must be a loopback URL, like ${defaultAddress(descriptor)}` };
  }
}

/** The reference each profile's policy accepts, which is also what the empty field shows. */
export function tokenReference(provider: ApiProviderId): string {
  return provider === 'ollama' ? OLLAMA_LOCAL_API_KEY_REFERENCE : 'env:MY_TOKEN';
}

export function tokenError(provider: ApiProviderId, token: string): string | undefined {
  if (token === '') return undefined;
  if (provider === 'ollama') {
    return isOllamaLocalCredentialReference(token)
      ? undefined
      : `Ollama accepts only ${OLLAMA_LOCAL_API_KEY_REFERENCE} on a loopback connection`;
  }
  const envVar = parseApiKeyEnvRef(token);
  if (envVar === undefined) return 'Token must reference an environment variable: env:NAME';
  return /^[A-Z_][A-Z0-9_]*$/.test(envVar)
    ? undefined
    : 'Environment variable names are uppercase: env:MY_TOKEN';
}

/** The runtime row T-045's four facts are read from; nothing here reaches the model cache. */
function runtimeOf(input: {
  role: SeatPickerRole;
  provider: ApiProviderId;
  at: string;
  outcome: ProviderCatalogOutcome;
}): ConfiguredProviderRuntime {
  const now = Date.now();
  const connection = {
    role: seatPickerLane(input.role),
    provider: input.provider,
    contextKey: input.at,
  };
  const { outcome } = input;
  return outcome.kind === 'failed'
    ? {
        connection,
        state: 'failed',
        catalog: null,
        models: null,
        fetchedAt: null,
        validatedAt: now,
        failure: outcome.failure,
        diagnostic: outcome.diagnostic,
      }
    : {
        connection,
        state: 'fresh',
        catalog: outcome.catalog,
        models: outcome.models,
        fetchedAt: now,
        validatedAt: now,
      };
}

interface ConnectionStatus {
  readonly line: string;
  /** What the headline could not carry: the provider's own words, or the missing selection. */
  readonly detail: string | undefined;
  /** The server answered — with a catalog or with a refusal — so it is running. */
  readonly answered: boolean;
}

/**
 * One line for the state the form is in, and one for the fact under it. Only a credential
 * outcome reaches `unauthorized` (T-045), so a server that is simply down is never told to
 * fix a token. The address is the field two rows above and is not repeated here.
 */
export function connectionStatus(input: {
  role: SeatPickerRole;
  provider: ApiProviderId;
  name: string;
  probe: ProbeState;
  frame: string;
  /** The check past ten seconds: the provider, the check and the time. */
  slow: SlowProbeText | null;
  seatModel: string | undefined;
}): ConnectionStatus {
  const { probe, name } = input;
  const plain = (line: string, detail?: string): ConnectionStatus => ({
    line,
    detail,
    answered: false,
  });
  if (probe.kind === 'idle') {
    return plain(`Not checked yet${SOFT_SEP}⏎ asks what this server serves`);
  }
  if (probe.kind === 'refused') return plain(probe.message);
  if (probe.kind === 'checking') {
    return plain(
      input.slow === null
        ? `${input.frame} Checking…`
        : `${input.frame} Checking…${SOFT_SEP}${input.slow.name} ${input.slow.check}`,
    );
  }
  if (probe.kind === 'failed') return plain('The check could not run', probe.message);

  const facts = deriveProviderConnectionState({
    runtime: runtimeOf({ ...input, at: probe.at, outcome: probe.outcome }),
    ...(input.seatModel === undefined ? {} : { selectedModelId: input.seatModel }),
  });
  const listed = probe.outcome.kind === 'success' ? probe.outcome.models.length : 0;
  const malformed = probe.outcome.kind === 'failed' && probe.outcome.failure === 'malformed';
  const answers: Readonly<Record<typeof facts.connection, string>> = {
    connected:
      facts.catalog === 'empty'
        ? `${name} answered${SOFT_SEP}no models installed`
        : `${name} answered${SOFT_SEP}${listed} listed`,
    offline: `${name} is not reachable`,
    timeout: `${name} did not answer`,
    unauthorized: `${name} rejected the token${SOFT_SEP}check the reference`,
    invalid: malformed
      ? `${name} returned an unreadable catalog`
      : `${name} does not accept this address`,
    unknown: `${name} did not say what failed`,
  };
  const detail = (): string | undefined => {
    // An empty catalog already said the selection is not there; the line under it owes
    // the operator the remedy instead of the same fact in other words.
    if (facts.catalog === 'empty') return 'Install or load one, then retry';
    if (facts.selectedModel === 'missing' && input.seatModel !== undefined) {
      return `${name} does not serve "${input.seatModel}"`;
    }
    return probe.outcome.kind === 'failed' ? probe.outcome.diagnostic : undefined;
  };
  return {
    line: answers[facts.connection],
    detail: detail(),
    answered: malformed || facts.connection === 'connected' || facts.connection === 'unauthorized',
  };
}
