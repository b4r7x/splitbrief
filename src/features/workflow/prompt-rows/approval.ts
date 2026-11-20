import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text/sanitize.js';
import { SOFT_SEP } from '../../../core/separators.js';
import type { ActionClass } from '../../../core/schemas/enums.js';
import { OVERLAY_FRAME_ROWS } from '../../../core/navigation/overlay-rect.js';
import { RESULT_MENU_UNFOCUSED_LEGEND } from '../result/options.js';
import {
  formatKeyHints,
  SELECT_HINT,
  DENY_HINT,
  CONFIRM_HINT,
} from '../../../components/key-legend.js';

export const BORDER_ROWS = 2;
/** The blank rows inside an overlay card's border, above its title and under its body. */
export const CARD_PADDING_ROWS = OVERLAY_FRAME_ROWS - BORDER_ROWS;
/** The panel's blank rows: under the title, above the options and above the legend. */
export const PANEL_GAP_ROWS = 3;

// The title states the operation the run is asking for, in the words the reader would use to
// describe it. The subject line under it carries the path or command the sentence points at, so
// no row has to repeat the other and a multi-line disclosure still has somewhere to go.
export function approvalTitle(actionClass: ActionClass): string {
  if (actionClass === 'package_change') return 'Change a package manifest:';
  if (actionClass === 'destructive') return 'Destructive action:';
  if (actionClass === 'sensitive_change') return 'Change a CI or secret file:';
  if (actionClass === 'runner_trust') return 'Trust and run a configured runner:';
  return "Write outside the brief's declared files:";
}

export const CHOOSE_HINTS = formatKeyHints([SELECT_HINT, { key: '⏎', verb: 'confirm' }, DENY_HINT]);
export const CONFIRM_REASON_HINTS = formatKeyHints([CONFIRM_HINT, DENY_HINT]);
export const CONFIRM_QUESTION = 'Why are you making this change?';
export const CONFIRM_REASON_OPTIONAL = 'leave empty to record no reason';
export const IRREVERSIBLE_NOTE = 'this cannot be undone';

// The refusal replaces the legend rather than adding a row, so it has to carry the way out with
// it: the moment a user mis-keys on the most dangerous panel is not the moment to hide `esc`.
export function confirmNudge(actionClass: ActionClass): string {
  const confirm = actionClass === 'runner_trust' ? '⏎ trusts this runner' : '⏎ confirms this write';
  return `${confirm}${SOFT_SEP}${formatKeyHints([DENY_HINT])}`;
}

/** The legends of the choose step: too narrow a row sheds their trailing keys. */
export function chooseLegends(actionClass: ActionClass): string[] {
  return [CHOOSE_HINTS, confirmNudge(actionClass)];
}

// A prompt that leaves the keys in the composer names what ⏎ does down there. A slash command
// runs; plain words only queue where the phase takes them; a blank draft takes ⏎ back to the
// panel, so it names both keys. The long token is kept whole where the width holds it.
export const PROMPT_COMMAND_LEGEND = '⏎ runs the command';

export function unfocusedPromptLegend(input: {
  blank: boolean;
  command: boolean;
  words: Readonly<{ long: string; short: string }> | null;
  width: number;
}): string {
  if (input.blank) return 'tab/⏎ back to the actions';
  if (input.command) return `${PROMPT_COMMAND_LEGEND}${SOFT_SEP}${RESULT_MENU_UNFOCUSED_LEGEND}`;
  if (input.words === null) return RESULT_MENU_UNFOCUSED_LEGEND;
  const long = `${input.words.long}${SOFT_SEP}${RESULT_MENU_UNFOCUSED_LEGEND}`;
  if (getTerminalCellWidth(long) <= input.width) return long;
  return `${input.words.short}${SOFT_SEP}${RESULT_MENU_UNFOCUSED_LEGEND}`;
}

// The engine rejects a confirm response with an empty reason, so a keyed confirm still
// carries one — worded so the evidence trail cannot be mistaken for a stated reason.
export const CONFIRM_REASON_UNSTATED = 'confirmed at the prompt (no reason given)';

export interface ApprovalOption {
  key: string;
  name: string;
}

export function getApprovalConfirmLabel(actionClass: ActionClass): string {
  if (actionClass === 'destructive') return 'Write to a protected project file';
  if (actionClass === 'package_change') return 'package manifest write';
  if (actionClass === 'sensitive_change') return 'CI or secret file write';
  if (actionClass === 'runner_trust') return 'runner command from the project config';
  return 'confirm file write';
}

export function isIrreversibleActionClass(actionClass: ActionClass): boolean {
  return actionClass === 'destructive';
}

// A control-plane write carries no key on its Confirm row: `y` is refused there, so the row
// takes the shared ⏎ instead of an accelerator and the key column stays one cell wide. Every
// other confirm-tier gate keeps `y` on the row.
export function getConfirmPrimaryKey(actionClass: ActionClass): string {
  return isIrreversibleActionClass(actionClass) ? '' : 'y';
}

// A runner trust stores a receipt of the exact runner and nothing else, so it asks for no reason.
export function getConfirmOptions(actionClass: ActionClass): ReadonlyArray<ApprovalOption> {
  const confirm = { key: getConfirmPrimaryKey(actionClass), name: 'Confirm' };
  const deny = { key: 'x', name: 'Deny' };
  if (actionClass === 'runner_trust') return [confirm, deny];
  return [confirm, { key: 'r', name: 'Confirm with a reason' }, deny];
}

/**
 * Trust disclosures arrive as one line per fact. Collapsing them would run the
 * executable, its argv, and the environment note together into a single line
 * the reader has to re-parse, so the breaks survive sanitization and the row
 * math below counts them.
 */
export function formatApprovalActionDescription(actionDescription: string): string {
  return sanitizeTerminalDisplayText(actionDescription, { preserveLineBreaks: true });
}
