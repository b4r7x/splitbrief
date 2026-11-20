import { planListRows } from '../../../components/list-row/plan.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { countNoun } from '../../../utils/pluralize.js';
import { fitKeyLegend } from '../../../components/key-legend.js';
import type { OverlayCard } from '../../../components/overlays/panel.js';
import type { TieredApprovalRequest } from '../../../core/approval/types.js';
import type { ActionClass } from '../../../core/schemas/enums.js';
import type { ApprovalPromptState } from '../../../stores/prompts/approval.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text/truncate.js';
import { wrapHard } from '../../../utils/display-text/wrap.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import {
  getConfirmOptions,
  chooseLegends,
  CONFIRM_QUESTION,
  CONFIRM_REASON_OPTIONAL,
  CONFIRM_REASON_HINTS,
  approvalTitle,
  getApprovalConfirmLabel,
  isIrreversibleActionClass,
  IRREVERSIBLE_NOTE,
  BORDER_ROWS,
  CARD_PADDING_ROWS,
  formatApprovalActionDescription,
  PANEL_GAP_ROWS,
} from './approval.js';
import { wrappedRows, approvalBoxTextWidth, wrapPathAwareText, pathAwareRows } from './measure.js';

interface ConfirmPanelRows {
  title: number;
  label: number;
  note: number;
  options: number[];
  /** The rows that answer: the option rows, or the reason step above its legend, if taller. */
  answer: number;
  /** The taller legend: the choose step's or the reason step's. */
  legend: number;
  /** The taller step under the options gap: the options and the legend, or the reason step. */
  core: number;
}

function confirmPanelRows(actionClass: ActionClass, width: number): ConfirmPanelRows {
  const options = getConfirmOptions(actionClass);
  const lines = planListRows(options, { width });
  const optionRows = options.map((_, i) => lines.filter((line) => line.row === i).length);
  const chooseLegend = Math.max(
    ...chooseLegends(actionClass).map((legend) => wrappedRows(fitKeyLegend(legend, width), width)),
  );
  const chooseAnswer = optionRows.reduce((rows, optionRow) => rows + optionRow, 0);
  const reason = options.some((option) => option.key === 'r');
  const reasonAnswer = reason
    ? wrappedRows(CONFIRM_QUESTION, width) + 1 + wrappedRows(CONFIRM_REASON_OPTIONAL, width)
    : 0;
  const reasonLegend = reason ? wrappedRows(CONFIRM_REASON_HINTS, width) : 0;
  return {
    title: wrappedRows(approvalTitle(actionClass), width),
    label: wrappedRows(getApprovalConfirmLabel(actionClass), width),
    note: isIrreversibleActionClass(actionClass) ? wrappedRows(IRREVERSIBLE_NOTE, width) : 0,
    options: optionRows,
    answer: Math.max(chooseAnswer, reasonAnswer),
    legend: Math.max(chooseLegend, reasonLegend),
    core: Math.max(chooseAnswer + chooseLegend, reasonAnswer + reasonLegend),
  };
}

/**
 * Where the confirm panel paints. On the workflow screen it draws its own heavy box inside the
 * gutter (`box`). On a page it is the body of a titled overlay card (`card`), whose blank rows are
 * the panel's to give back. `width` is the width every line of text wraps to.
 */
export type ConfirmFrame =
  | Readonly<{ width: number; kind: 'box' }>
  | Readonly<{ width: number; kind: 'card'; card: OverlayCard }>;

type ConfirmSubject = Pick<TieredApprovalRequest, 'actionClass' | 'actionDescription'>;

export function ownConfirmFrame(
  paintWidth: number,
  request: ConfirmSubject,
  composerLegend = '',
  boxRows?: number,
): ConfirmFrame {
  const available = approvalBoxTextWidth(paintWidth);
  const { actionClass, actionDescription } = request;
  const options = getConfirmOptions(actionClass);
  const text = [
    approvalTitle(actionClass),
    getApprovalConfirmLabel(actionClass),
    composerLegend,
    ...chooseLegends(actionClass),
    ...formatApprovalActionDescription(actionDescription).split('\n'),
    ...(options.some((option) => option.key === 'r')
      ? [CONFIRM_QUESTION, CONFIRM_REASON_OPTIONAL, CONFIRM_REASON_HINTS]
      : []),
  ];
  const widest = Math.max(
    ...text.map(getTerminalCellWidth),
    ...planListRows(options, { width: available }).map((line) => line.cells),
  );
  const frame = { width: Math.min(available, widest), kind: 'box' } as const;
  if (boxRows === undefined || frame.width === available) return frame;
  const fit = fitConfirmPanel({ ...request, frame, boxRows });
  if (fit.subject.length === 0) {
    const action = textOfFirstFact(request);
    const combined = planListRows(
      options.map((option) => ({ ...option, name: option.name + SOFT_SEP + action })),
      { width: available },
    );
    return {
      ...frame,
      width: Math.min(available, Math.max(widest, ...combined.map((line) => line.cells + 1))),
    };
  }
  const titleWithCount =
    fit.hidden > 0 && fit.title && !fit.markRow
      ? getTerminalCellWidth(
          approvalTitle(actionClass) + '  … ' + countNoun(fit.hidden, 'more line'),
        )
      : 0;
  return { ...frame, width: Math.min(available, Math.max(widest, titleWithCount)) };
}

export function textOfFirstFact(request: ConfirmSubject) {
  return formatApprovalActionDescription(request.actionDescription).split('\n')[0] ?? '';
}

/** The blank rows an overlay card keeps: its padding rows and the row under its title. */
export interface CardSpacing {
  padding: boolean;
  titleGap: boolean;
}

const NO_CARD_SPACING: CardSpacing = { padding: false, titleGap: false };
const FULL_CARD_SPACING: CardSpacing = { padding: true, titleGap: true };

/** The rows an overlay card keeps around its body: its border, its title and the blank rows kept. */
function cardRows(frame: ConfirmFrame, spacing: CardSpacing): number {
  if (frame.kind === 'box') return 0;
  return (
    BORDER_ROWS +
    wrappedRows(frame.card.title, frame.width) +
    (spacing.padding ? CARD_PADDING_ROWS : 0) +
    (spacing.titleGap ? 1 : 0)
  );
}

export interface ConfirmPanelFit {
  framed: boolean;
  card: CardSpacing;
  /** The rows the panel's own box takes: the region less the card's rows around it. */
  bodyRows: number;
  title: boolean;
  /** The blank rows kept: under the title, above the options, above the legend. */
  gaps: { title: boolean; options: boolean; legend: boolean };
  label: boolean;
  subject: string[];
  /** The cut rows of text, counted on their own row or, with no row for it, after the title. */
  hidden: number;
  scroll?: { lines: string[]; start: number; height: number };
  markRow: boolean;
  note: boolean;
  /** How many option rows paint, from the first. */
  options: number;
  legend: boolean;
}

/**
 * What a region of `boxRows` keeps of the panel. The option rows are the answer and the title is
 * what the answer decides, so they stay longest. A card gives way first by its own blank rows: its
 * padding rows, then the row under its title; it keeps its border and title. Then the panel gives
 * way by its blank rows: the one under the title, then the one above the legend, then the one above
 * the options, so the facts run into the keys last. A framed panel with no spare row has no blank
 * row. A region too short for the framed panel without its blank rows drops the border and is
 * filled in this order:
 * the option rows, the title, the legend, the disclosure, the label, the irreversible note, the
 * blank row above the options, the blank row above the legend. The panel never asks blind: two
 * rows or more keep the first line of the action ahead of that order, cut to the rows it gets with
 * `…` at the cut, and one row carries it after the option. The label restates the title, so it
 * gives way before any disclosure line. The disclosure gives way from the bottom, a whole line at a
 * time, because the first lines name what runs. A row under the kept lines counts the cut rows,
 * with a blank row under it, as `clipPromptBodyRows` keeps the facts off the keys. With
 * fewer than three rows for the text, or with every disclosure line in view and only the label
 * cut, the title carries the count, so no row holds the count alone. A row the whole lines leave
 * free goes to the label. A region too short for the option rows and the title drops the title,
 * then cuts the option rows to the ones that fit. The cut list follows the mark, so no row paints
 * or answers outside the region. The reason step takes the option rows' place and keeps its legend
 * on the same terms.
 */
export function fitConfirmPanel(input: {
  actionClass: ActionClass;
  actionDescription: string;
  frame: ConfirmFrame;
  boxRows: number;
}): ConfirmPanelFit {
  const { frame } = input;
  const rows = confirmPanelRows(input.actionClass, frame.width);
  const descriptionLines = formatApprovalActionDescription(input.actionDescription).split('\n');
  const lines = descriptionLines.map((fact) => {
    const parts = wrapPathAwareText(fact, frame.width).split('\n');
    // Keep the final words of a disclosure together when the last line would hold one word alone.
    const last = parts.at(-1);
    const previous = parts.at(-2);
    if (last && previous && !last.includes(' ')) {
      const split = previous.lastIndexOf(' ');
      const pair = previous.slice(split + 1) + ' ' + last;
      if (split > 0 && getTerminalCellWidth(pair) <= frame.width) {
        parts[parts.length - 2] = previous.slice(0, split);
        parts[parts.length - 1] = pair;
      }
    }
    return parts;
  });
  const subjectRows = lines.flat();
  const minRows = confirmPanelMinRows(input, frame);
  const spare = input.boxRows - minRows;
  if (spare >= 0) {
    const card = {
      titleGap: frame.kind === 'card' && spare >= 4,
      padding: frame.kind === 'card' && spare >= 4 + CARD_PADDING_ROWS,
    };
    return {
      framed: frame.kind === 'box',
      card,
      // The body holds its own blank rows only. A row the card's padding cannot take as a pair stays
      // outside the card, where the panel centres it like any odd row.
      bodyRows: minRows - cardRows(frame, NO_CARD_SPACING) + Math.min(spare, PANEL_GAP_ROWS),
      title: true,
      gaps: { title: spare >= PANEL_GAP_ROWS, options: spare >= 1, legend: spare >= 2 },
      label: true,
      subject: subjectRows,
      hidden: 0,
      markRow: false,
      note: true,
      options: rows.options.length,
      legend: true,
    };
  }
  const optionRows = rows.options.reduce((total, optionRow) => total + optionRow, 0);
  const bodyRows = input.boxRows - cardRows(frame, NO_CARD_SPACING);
  const actionRows = bodyRows >= 2 ? 1 : 0;
  // The reason step replaces the option rows, so a taller one keeps its rows too.
  let room = bodyRows - actionRows - (rows.answer - optionRows);
  let options = 0;
  for (const optionRow of rows.options) {
    if (optionRow > room) break;
    room -= optionRow;
    options += 1;
  }
  const title = room >= rows.title;
  if (title) room -= rows.title;
  const legend = room >= rows.legend;
  if (legend) room -= rows.legend;
  room += actionRows;
  const textRoom = Math.max(0, room);
  // A count on its own row keeps a blank row under it, so it does not run into the options.
  const countRow = subjectRows.length > textRoom && textRoom >= 3;
  const lineRoom = countRow ? textRoom - 2 : textRoom;
  const subject: string[] = [];
  let cutRows: string[] | null = null;
  for (const line of lines) {
    if (subject.length + line.length > lineRoom) {
      if (subject.length === 0) {
        const hardRows = wrapHard(descriptionLines[0] ?? '', frame.width).split('\n');
        const kept = hardRows.slice(0, lineRoom);
        if (kept.length > 0 && kept.length < hardRows.length) {
          kept[kept.length - 1] = truncateTerminalDisplayText(
            hardRows.slice(kept.length - 1).join(''),
            frame.width,
          );
        }
        subject.push(...kept);
        cutRows = [...hardRows.slice(kept.length), ...lines.slice(1).flat()];
      }
      break;
    }
    subject.push(...line);
  }
  while (subject.at(-1)?.trim() === '') subject.pop();
  const label = rows.label <= lineRoom - subject.length;
  const hidden =
    (label ? 0 : rows.label) +
    (cutRows ?? subjectRows.slice(subject.length)).filter((row) => row.trim() !== '').length;
  const markRow = countRow && hidden > 0 && (label || subject.length > 0);
  room -= (label ? rows.label : 0) + subject.length + (markRow ? 1 : 0);
  const note = room - (markRow ? 1 : 0) >= rows.note;
  if (note) room -= rows.note;
  const disclosure = [
    getApprovalConfirmLabel(input.actionClass),
    ...descriptionLines,
    ...(rows.note ? [IRREVERSIBLE_NOTE] : []),
  ];
  let scroll: ConfirmPanelFit['scroll'];
  if (options > 0 && (hidden > 0 || (!note && rows.note > 0))) {
    if (subject.length > 0) {
      scroll = {
        lines: [disclosure[0] ?? '', ...subjectRows, ...(rows.note ? [IRREVERSIBLE_NOTE] : [])],
        start: label ? 0 : 1,
        height: subject.length + Number(label) + Number(note && rows.note > 0),
      };
    } else {
      const optionWidth = Math.max(
        ...planListRows(getConfirmOptions(input.actionClass), frame).map((line) => line.cells),
      );
      const factWidth = Math.max(1, frame.width - optionWidth - getTerminalCellWidth(SOFT_SEP) - 1);
      scroll = {
        lines: disclosure.flatMap((fact) => wrapPathAwareText(fact, factWidth).split('\n')),
        start: 1,
        height: 1,
      };
    }
  }
  return {
    framed: false,
    card: NO_CARD_SPACING,
    bodyRows,
    title,
    gaps: { title: false, options: room >= 1, legend: room >= 2 },
    label,
    subject,
    hidden,
    ...(scroll && { scroll }),
    markRow,
    note,
    options,
    legend,
  };
}

/** The fewest rows that keep every line of the panel in view: no blank row, no count. */
export function confirmPanelMinRows(
  request: Pick<TieredApprovalRequest, 'actionClass' | 'actionDescription'>,
  frame: ConfirmFrame,
): number {
  const rows = confirmPanelRows(request.actionClass, frame.width);
  return (
    (frame.kind === 'box' ? BORDER_ROWS : cardRows(frame, NO_CARD_SPACING)) +
    rows.title +
    rows.label +
    pathAwareRows(formatApprovalActionDescription(request.actionDescription), frame.width) +
    rows.note +
    rows.core
  );
}

/**
 * Whether a card can take the question in a region of `regionRows`: every line of it in view and
 * every key of its legends whole. The card is narrower than the panel's own box, so a legend sheds
 * a key in the card that the box still shows.
 */
export function confirmCardFits(
  request: Pick<TieredApprovalRequest, 'actionClass' | 'actionDescription'>,
  frame: Extract<ConfirmFrame, { kind: 'card' }>,
  regionRows: number,
): boolean {
  return (
    chooseLegends(request.actionClass).every(
      (legend) => fitKeyLegend(legend, frame.width) === legend,
    ) && confirmPanelMinRows(request, frame) <= regionRows
  );
}

/** The rows the whole panel takes, every blank row and disclosure line in view. */
export function getConfirmPanelRows(request: TieredApprovalRequest, frame: ConfirmFrame): number {
  return (
    confirmPanelMinRows(request, frame) +
    PANEL_GAP_ROWS +
    cardRows(frame, FULL_CARD_SPACING) -
    cardRows(frame, NO_CARD_SPACING)
  );
}

export function getApprovalPromptRows(state: ApprovalPromptState, cols: number): number {
  if (state.status !== 'pending') return 0;
  return getConfirmPanelRows(
    state.request,
    ownConfirmFrame(getChromeContentWidth(cols), state.request),
  );
}
