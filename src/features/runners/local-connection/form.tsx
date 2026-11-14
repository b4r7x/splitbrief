import { Box } from 'ink';
import { ListRow } from '../../../components/list-row/row.js';
import {
  overlayInnerRowCapacity,
  OverlayPanel,
} from '../../../components/overlays/overlay-panel.js';
import { windowSlice } from '../../../components/pickers/scroll-offset.js';
import { useTheme } from '../../../components/theme.js';
import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { overlayRect } from '../../../core/navigation/overlay-rect.js';
import {
  type ApiProviderDescriptor,
  API_PROVIDER_CATALOG,
} from '../../../core/providers/api-provider-catalog.js';
import { localProviderStartup } from '../../../core/readiness/checks/availability.js';
import { PICKER_ROLE_SEAT_IDS } from '../../../core/runners/seat-roles.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { CANCEL_HINT, formatKeyHints, SELECT_HINT } from '../../../components/key-legend.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import { LABEL_WIDTH, DimLine, FieldRow } from './field-row.js';
import { defaultAddress, tokenReference } from './model.js';
import type { LocalConnectionFormProps } from './types.js';
import { useLocalConnectionForm } from './use-form.js';

/** Rows above the model list: the profile, both fields, Check, the status, the detail, air. */
const FIXED_BODY_ROWS = 8;
/** `OverlayPanel` spends two rows on its title and two on its hint. */
const OVERLAY_CHROME_ROWS = 4;

export function LocalConnectionForm(props: LocalConnectionFormProps) {
  const { role, provider, seat } = props;
  const t = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const descriptor: ApiProviderDescriptor = API_PROVIDER_CATALOG[provider];
  const {
    apiBase,
    token,
    row,
    modelRows,
    modelIndex,
    status,
    checked,
    verb,
    move,
    runCheck,
    editAddress,
    editToken,
  } = useLocalConnectionForm(props);
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
      hint={formatKeyHints([
        SELECT_HINT,
        { key: '⏎', verb },
        { key: 'tab', verb: 'field' },
        CANCEL_HINT,
      ])}
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
        onChange={editAddress}
        onSubmit={runCheck}
        onLeave={(direction) => move(direction === 'up' ? -1 : 1)}
      />
      <FieldRow
        label="Token"
        value={token}
        placeholder={`${tokenReference(provider)}${SOFT_SEP}optional`}
        focused={row === 1}
        columns={fieldColumns}
        onChange={editToken}
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
