import { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import { overlayAllowsPickerKeys } from '../../../core/navigation/types.js';
import {
  type ApiProviderDescriptor,
  API_PROVIDER_CATALOG,
} from '../../../core/providers/api-catalog.js';
import { useSlowProbeText } from '../../../hooks/use-slow-probe-text.js';
import { useSpinnerFrame } from '../../../hooks/use-spinner-frame.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import {
  type ProbeState,
  localConnectionModelRows,
  normalizeAddress,
  defaultAddress,
  tokenError,
  contextOf,
  connectionStatus,
} from './model.js';
import type { LocalConnectionFormProps } from './types.js';

/** The rows above the catalog that Enter acts on: both fields and the check itself. */
const FIELD_ROW_COUNT = 3;

export function useLocalConnectionForm({
  role,
  provider,
  seat,
  check,
  onSave,
}: LocalConnectionFormProps) {
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

  return {
    apiBase,
    token,
    row,
    modelRows,
    modelIndex,
    status,
    checked,
    verb: modelIndex >= 0 ? 'save' : checked ? 'retry' : 'check',
    move,
    runCheck,
    editAddress: editField(setApiBase),
    editToken: editField(setToken),
  };
}
