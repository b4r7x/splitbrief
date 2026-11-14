import { localProviderStartup } from '../../../core/readiness/checks/availability.js';
import { billingWord } from '../../../core/runners/runner-billing.js';
import { SOFT_SEP } from '../../../core/separators.js';
import type { PickerOption } from '../model-catalog/options.js';
import { wrapOnWords } from './byline.js';
import { CUSTOM_COMMAND_PANE_CELLS, formatPermissionLabels } from './labels.js';

const MAX_STALE_MODEL_COPY_COUNT = 99;

/** Rows a failed refresh left behind are not a count the byline can claim. */
export function staleModelCopy(staleCount: number): string | undefined {
  if (staleCount <= 0) return undefined;
  const count = Math.min(staleCount, MAX_STALE_MODEL_COPY_COUNT);
  const label = staleCount > MAX_STALE_MODEL_COPY_COUNT ? `${count}+` : String(count);
  const noun = staleCount === 1 ? 'model' : 'models';
  return `${label} stale ${noun} retained. Refresh detection.`;
}

/** The remedy the card may spend before its own copy needs the rest of the budget. */
const PANE_REMEDY_LINES = 3;

/**
 * What the local-server row promises, written to the narrowest card the picker draws
 * (23 cells at 60 columns, `CUSTOM_COMMAND_PANE_CELLS`): what to do about this server,
 * what Enter opens, and that landing on the row has saved nothing. A server that is
 * simply not answering needs starting, and the probe's own words for that are evidence
 * rather than an instruction — they wait in the form, under a check. Any other status
 * keeps its own remedy, so a rejected credential is never told to start a server that
 * is already running. The address is not repeated here: the form owns it.
 */
export function localConnectionPaneLines(item: PickerOption): string[] {
  const remediation =
    item.status.state === 'unavailable'
      ? (localProviderStartup(item.id) ?? item.status.remediation)
      : item.status.remediation;
  const remedy =
    remediation === null
      ? []
      : // The remedy keeps what fits the narrowest card; the card breaks it again at its own width.
        [
          wrapOnWords(remediation, CUSTOM_COMMAND_PANE_CELLS, PANE_REMEDY_LINES).lines.join(' '),
          '',
        ];
  return [...remedy, '⏎ opens its address, its token and a check.', '', 'Nothing is saved yet.'];
}

export function postureLine(item: PickerOption): string {
  return [billingWord(item.billing), ...formatPermissionLabels(item.permissions)]
    .filter(Boolean)
    .join(SOFT_SEP);
}
