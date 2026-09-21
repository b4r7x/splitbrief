import { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ListRow } from '../../components/list-row.js';
import { MultilineInput } from '../../components/input/multiline-input.js';
import { OverlayPanel, overlayInnerRowCapacity } from '../../components/overlays/overlay-panel.js';
import { windowSlice } from '../../components/pickers/scroll-window.js';
import { useTheme } from '../../components/theme.js';
import { parseApiKeyEnvRef } from '../../core/config/credentials.js';
import { CREW_SEAT_LABELS } from '../../core/crew/identity.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import { overlayAllowsPickerKeys } from '../../core/navigation/types.js';
import { overlayRect } from '../../core/navigation/overlay-rect.js';
import {
  API_PROVIDER_CATALOG,
  getApiProviderDescriptor,
  type ApiProviderDescriptor,
  type ApiProviderId,
} from '../../core/providers/api-provider-catalog.js';
import { normalizeProviderEndpoint } from '../../core/providers/endpoint-policy.js';
import { localProviderStartup } from '../../core/readiness/checks/availability.js';
import {
  isOllamaLocalCredentialReference,
  OLLAMA_LOCAL_API_KEY_REFERENCE,
} from '../../core/providers/ollama-credential.js';
import {
  PICKER_ROLE_SEAT_IDS,
  seatPickerLane,
  type SeatPickerRole,
} from '../../core/runners/seat-roles.js';
import { SOFT_SEP } from '../../core/separators.js';
import type { ConfiguredProviderRuntime } from '../../engine/detection/provider-outcomes.js';
import { deriveProviderConnectionState } from '../../engine/providers/connection-state.js';
import { apiConnectionContextKey } from '../../engine/providers/selected-model.js';
import type { ProviderCatalogOutcome } from '../../engine/providers/types.js';
import { useSpinnerFrame } from '../../hooks/use-spinner-frame.js';
import { glyph } from '../../lib/glyphs.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { useStores } from '../../stores/use-stores.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import type { PickerOption } from './model-catalog/options.js';

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

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'refused'; message: string }
  | { kind: 'checking'; at: string }
  | { kind: 'failed'; at: string; message: string }
  | { kind: 'done'; at: string; outcome: ProviderCatalogOutcome };

/** The endpoint a result belongs to: a catalog never outlives the address it came from. */
function contextOf(provider: ApiProviderId, apiBase: string, token: string): string {
  return `${apiConnectionContextKey(provider, apiBase)}|${token === '' ? 'anonymous' : 'token'}`;
}

function defaultAddress(descriptor: ApiProviderDescriptor): string {
  return descriptor.endpointPolicy.kind === 'loopback'
    ? descriptor.endpointPolicy.defaultBaseURL
    : '';
}

function normalizeAddress(
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
function tokenReference(provider: ApiProviderId): string {
  return provider === 'ollama' ? OLLAMA_LOCAL_API_KEY_REFERENCE : 'env:MY_TOKEN';
}

function tokenError(provider: ApiProviderId, token: string): string | undefined {
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
function connectionStatus(input: {
  role: SeatPickerRole;
  provider: ApiProviderId;
  name: string;
  probe: ProbeState;
  frame: string;
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
  if (probe.kind === 'checking') return plain(`${input.frame} checking…`);
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

/** Rows above the model list: the profile, both fields, Check, the status, the detail, air. */
const FIXED_BODY_ROWS = 8;
/** The rows above the catalog that Enter acts on: both fields and the check itself. */
const FIELD_ROW_COUNT = 3;
/** `OverlayPanel` spends two rows on its title and two on its hint. */
const OVERLAY_CHROME_ROWS = 4;
const LABEL_WIDTH = 10;

function DimLine({ text, color }: { text: string; color?: string | undefined }) {
  const t = useTheme();
  return (
    <Box height={1} overflow="hidden">
      <Text color={color ?? t.textDim} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  );
}

function FieldRow(props: {
  label: string;
  value: string;
  placeholder: string;
  focused: boolean;
  columns: number;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onLeave: (direction: 'up' | 'down') => void;
}) {
  const t = useTheme();
  return (
    <Box height={1} overflow="hidden">
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text color={props.focused ? t.accent : t.textDim}>
          {`${props.focused ? glyph('liveBar') : ' '} ${props.label}`}
        </Text>
      </Box>
      <Box flexGrow={1} minWidth={0}>
        <MultilineInput
          value={props.value}
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          rows={1}
          maxRows={1}
          columns={props.columns}
          placeholder={props.placeholder}
          keepPlaceholderWhileFocused
          focus={props.focused}
          onBoundaryNavigate={(direction) => {
            props.onLeave(direction);
            return true;
          }}
          keyBindings={{ submit: (key) => key.return, newline: () => false }}
        />
      </Box>
    </Box>
  );
}

export function LocalConnectionForm({
  role,
  provider,
  seat,
  check,
  onSave,
}: {
  role: SeatPickerRole;
  provider: ApiProviderId;
  seat: LocalConnectionSeat;
  check: LocalConnectionProbe;
  onSave: (input: LocalConnectionSave) => void;
}) {
  const t = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const descriptor: ApiProviderDescriptor = API_PROVIDER_CATALOG[provider];
  const [apiBase, setApiBase] = useState(seat.apiBase);
  const [token, setToken] = useState(seat.apiKey ?? '');
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });
  const checkGeneration = useRef(0);
  const [index, setIndex] = useState(0);
  const focus = overlayStore.use((s) => overlayAllowsPickerKeys(s.active));
  const { frame } = useSpinnerFrame(probe.kind === 'checking');

  const catalog =
    probe.kind === 'done' && probe.outcome.kind === 'success' ? probe.outcome.models : undefined;
  const modelRows = localConnectionModelRows({
    seatModel: seat.model,
    catalog,
    probed: probe.kind === 'done' || probe.kind === 'failed',
  });
  const rowCount = FIELD_ROW_COUNT + modelRows.length;
  const row = Math.min(index, rowCount - 1);
  const modelIndex = row - FIELD_ROW_COUNT;
  const editing = row < FIELD_ROW_COUNT - 1;
  const move = (delta: number) =>
    setIndex((prev) => (Math.min(prev, rowCount - 1) + delta + rowCount) % rowCount);

  const resolveDraft = (): { apiBase: string; apiKey: string | undefined } | undefined => {
    // The field's placeholder is the profile's own default, so an emptied field means
    // exactly what it shows rather than an address of nothing.
    const address = normalizeAddress(
      descriptor,
      apiBase.trim() === '' ? defaultAddress(descriptor) : apiBase,
    );
    if ('error' in address) {
      setProbe({ kind: 'refused', message: address.error });
      return undefined;
    }
    const trimmed = token.trim();
    const issue = tokenError(provider, trimmed);
    if (issue !== undefined) {
      setProbe({ kind: 'refused', message: issue });
      return undefined;
    }
    return { apiBase: address.apiBase, apiKey: trimmed === '' ? undefined : trimmed };
  };

  const runCheck = () => {
    const generation = ++checkGeneration.current;
    const draft = resolveDraft();
    if (draft === undefined) return;
    const at = contextOf(provider, draft.apiBase, draft.apiKey ?? '');
    const settle = (next: ProbeState) => {
      if (generation !== checkGeneration.current) return;
      setProbe((prev) => (prev.kind === 'checking' && prev.at === at ? next : prev));
    };
    setProbe({ kind: 'checking', at });
    void check({
      provider,
      apiBase: draft.apiBase,
      ...(draft.apiKey === undefined ? {} : { apiKey: draft.apiKey }),
    })
      .then((outcome) => settle({ kind: 'done', at, outcome }))
      .catch((err: unknown) => settle({ kind: 'failed', at, message: toErrorMessage(err) }));
  };

  const activate = () => {
    const model = modelRows[modelIndex];
    if (model === undefined) {
      // One probe at a time: Enter on a check already in flight starts nothing new.
      if (probe.kind !== 'checking') runCheck();
      return;
    }
    const draft = resolveDraft();
    if (draft !== undefined) onSave({ provider, ...draft, model: model.id });
  };

  // An edited address or token is a different connection, so the last check stops
  // standing for it.
  const editField = (setter: (next: string) => void) => (next: string) => {
    checkGeneration.current += 1;
    setter(next);
    setProbe({ kind: 'idle' });
  };

  useInput(
    (_input, key) => {
      if (key.tab) {
        move(1);
        return;
      }
      if (editing) return;
      if (key.upArrow) move(-1);
      else if (key.downArrow) move(1);
      else if (key.return) activate();
    },
    { isActive: focus },
  );

  const status = connectionStatus({
    role,
    provider,
    name: descriptor.displayName,
    probe,
    frame,
    seatModel: seat.model,
  });
  const checked = probe.kind === 'done' || probe.kind === 'failed';
  const verb = modelIndex >= 0 ? 'save' : checked ? 'retry' : 'check';
  const innerWidth = overlayRect({ cols, rows, density: 'roomy' }).innerWidth;
  const fieldColumns = Math.max(1, innerWidth - LABEL_WIDTH);
  // The operator starts the server, so the instruction stands until this connection has
  // answered — and then it has nothing left to say, and the row it held goes to the
  // catalog that now exists.
  const startup = status.answered
    ? undefined
    : (localProviderStartup(provider) ?? `Start ${descriptor.service}`);
  const slice = windowSlice({
    items: modelRows,
    selectedIndex: Math.max(0, modelIndex),
    windowSize: Math.max(
      1,
      overlayInnerRowCapacity({ rows, outerChromeRows: OVERLAY_CHROME_ROWS }) -
        FIXED_BODY_ROWS -
        (startup === undefined ? 0 : 1),
    ),
  });

  return (
    <OverlayPanel
      density="roomy"
      title={`Local server${SOFT_SEP}${CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS[role]]}`}
      hint={`↑↓ select${SOFT_SEP}⏎ ${verb}${SOFT_SEP}tab field${SOFT_SEP}esc cancel`}
    >
      <DimLine
        text={
          descriptor.compatibility === 'verified'
            ? descriptor.displayName
            : `${descriptor.displayName}${SOFT_SEP}${descriptor.compatibility} profile`
        }
      />
      {startup === undefined ? null : <DimLine text={startup} />}
      <Box height={1} />
      <FieldRow
        label="Address"
        value={apiBase}
        placeholder={defaultAddress(descriptor)}
        focused={row === 0}
        columns={fieldColumns}
        onChange={editField(setApiBase)}
        onSubmit={runCheck}
        onLeave={(direction) => move(direction === 'up' ? -1 : 1)}
      />
      <FieldRow
        label="Token"
        value={token}
        placeholder={`${tokenReference(provider)}${SOFT_SEP}optional`}
        focused={row === 1}
        columns={fieldColumns}
        onChange={editField(setToken)}
        onSubmit={runCheck}
        onLeave={(direction) => move(direction === 'up' ? -1 : 1)}
      />
      <Box height={1} />
      <ListRow
        label={`${checked ? 'Retry' : 'Check'} this connection`}
        state={row === 2 ? 'active' : 'default'}
        width={innerWidth}
      />
      <DimLine text={status.line} />
      {status.detail === undefined ? (
        <Box height={1} />
      ) : (
        <DimLine text={status.detail} color={t.warning} />
      )}
      {slice.visibleSlice.map((model) => (
        <ListRow
          key={model.id}
          label={model.label}
          state={modelRows[modelIndex]?.id === model.id ? 'active' : 'default'}
          width={innerWidth}
          trailing={model.state}
          selected={model.id === seat.model}
          {...(model.label === model.id ? {} : { metadata: model.id })}
          {...(model.state === 'not in this catalog' ? { trailingColor: t.warning } : {})}
        />
      ))}
    </OverlayPanel>
  );
}
