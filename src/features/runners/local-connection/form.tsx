import { useEffect, useRef, useState } from 'react';
import { Box, useInput } from 'ink';
import { ListRow } from '../../../components/list-row/row.js';
import {
  overlayInnerRowCapacity,
  OverlayPanel,
} from '../../../components/overlays/overlay-panel.js';
import { windowSlice } from '../../../components/pickers/scroll-offset.js';
import { useTheme } from '../../../components/theme.js';
import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { overlayRect } from '../../../core/navigation/overlay-rect.js';
import { overlayAllowsPickerKeys } from '../../../core/navigation/types.js';
import {
  type ApiProviderId,
  type ApiProviderDescriptor,
  API_PROVIDER_CATALOG,
} from '../../../core/providers/api-provider-catalog.js';
import { localProviderStartup } from '../../../core/readiness/checks/availability.js';
import { type SeatPickerRole, PICKER_ROLE_SEAT_IDS } from '../../../core/runners/seat-roles.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { useSlowProbeText } from '../../../hooks/use-slow-probe-text.js';
import { useSpinnerFrame } from '../../../hooks/use-spinner-frame.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { LABEL_WIDTH, DimLine, FieldRow } from './field-row.js';
import {
  type LocalConnectionSeat,
  type LocalConnectionProbe,
  type LocalConnectionSave,
  type ProbeState,
  localConnectionModelRows,
  normalizeAddress,
  defaultAddress,
  tokenError,
  contextOf,
  connectionStatus,
  tokenReference,
} from './model.js';

/** Rows above the model list: the profile, both fields, Check, the status, the detail, air. */
const FIXED_BODY_ROWS = 8;
/** The rows above the catalog that Enter acts on: both fields and the check itself. */
const FIELD_ROW_COUNT = 3;
/** `OverlayPanel` spends two rows on its title and two on its hint. */
const OVERLAY_CHROME_ROWS = 4;

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
  const runningCheck = useRef<AbortController | null>(null);
  const [index, setIndex] = useState(0);
  const focus = overlayStore.use((s) => overlayAllowsPickerKeys(s.active));
  const { frame } = useSpinnerFrame(probe.kind === 'checking');
  const slow = useSlowProbeText(provider);

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

  useEffect(() => () => runningCheck.current?.abort(), []);

  const runCheck = () => {
    runningCheck.current?.abort();
    const draft = resolveDraft();
    if (draft === undefined) return;
    const running = new AbortController();
    runningCheck.current = running;
    const at = contextOf(provider, draft.apiBase, draft.apiKey ?? '');
    const settle = (next: ProbeState) => {
      if (running.signal.aborted) return;
      setProbe((prev) => (prev.kind === 'checking' && prev.at === at ? next : prev));
    };
    setProbe({ kind: 'checking', at });
    void check({
      provider,
      apiBase: draft.apiBase,
      ...(draft.apiKey === undefined ? {} : { apiKey: draft.apiKey }),
      signal: running.signal,
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
    runningCheck.current?.abort();
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
    slow,
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
        <DimLine text={status.detail} tone="warning" />
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
