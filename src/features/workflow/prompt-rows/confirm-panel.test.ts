import { describe, expect, it } from 'vitest';
import {
  confirmPanelMinRows,
  fitConfirmPanel,
  getApprovalPromptRows,
  getConfirmPanelRows,
  ownConfirmFrame,
} from './confirm-panel.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { SOFT_SEP } from '../../../core/separators.js';

describe('fitConfirmPanel', () => {
  const actionDescription = ['A: one', `B: ${'word '.repeat(30).trim()}`, 'C: three'].join('\n');
  const request = {
    tier: 'confirm',
    actionClass: 'runner_trust',
    actionDescription,
    phase: 'planning',
  } as const;
  const fullRows = getApprovalPromptRows({ status: 'pending', request, resolve: () => {} }, 60);
  const fitIn = (boxRows: number) =>
    fitConfirmPanel({
      actionClass: 'runner_trust',
      actionDescription,
      frame: ownConfirmFrame(getChromeContentWidth(60)),
      boxRows,
    });

  it('sheds blank rows first, keeping the one above the options longest', () => {
    expect(fitIn(fullRows - 1)).toMatchObject({
      framed: true,
      gaps: { title: false, options: true, legend: true },
    });
    expect(fitIn(fullRows - 2)).toMatchObject({
      framed: true,
      gaps: { title: false, options: true, legend: false },
      subject: expect.arrayContaining(['A: one', 'C: three']),
      hidden: 0,
    });
    expect(fitIn(fullRows - 3)).toMatchObject({
      framed: true,
      gaps: { title: false, options: false, legend: false },
      hidden: 0,
    });
  });

  it('then drops the border, before any text', () => {
    expect(fitIn(fullRows - 5)).toMatchObject({
      framed: false,
      title: true,
      gaps: { title: false, options: false, legend: false },
      label: true,
      subject: expect.arrayContaining(['A: one', 'C: three']),
      hidden: 0,
      options: 2,
      legend: true,
    });
  });

  it('in a card gives back its padding, then its title gap, before the panel blank rows', () => {
    const frame = {
      width: 30,
      kind: 'card',
      card: { title: `Tool preparation${SOFT_SEP}Needs you`, density: 'roomy' },
    } as const;
    const cardRows = getConfirmPanelRows(request, frame);
    const fitCard = (boxRows: number) =>
      fitConfirmPanel({ actionClass: 'runner_trust', actionDescription, frame, boxRows });
    expect(fitCard(cardRows)).toMatchObject({
      framed: false,
      card: { padding: true, titleGap: true },
      gaps: { title: true, options: true, legend: true },
      hidden: 0,
    });
    expect(fitCard(cardRows).subject.every((line) => line.length <= 30)).toBe(true);
    expect(fitCard(cardRows - 1)).toMatchObject({
      card: { padding: false, titleGap: true },
      gaps: { title: true, options: true, legend: true },
      hidden: 0,
    });
    expect(fitCard(cardRows - 3)).toMatchObject({
      card: { padding: false, titleGap: false },
      gaps: { title: true, options: true, legend: true },
      hidden: 0,
    });
    expect(fitCard(cardRows - 6)).toMatchObject({
      card: { padding: false, titleGap: false },
      gaps: { title: false, options: false, legend: false },
      label: true,
      hidden: 0,
    });
    // The card keeps its border and title row, so the panel's own box takes the rest.
    expect(fitCard(cardRows - 6).bodyRows).toBe(cardRows - 6 - 3);
  });

  it('counts every row of a card title that wraps', () => {
    const card = (title: string) =>
      ({ width: 30, kind: 'card', card: { title, density: 'roomy' } }) as const;
    const short = card('Needs you');
    const wrapping = card(`Tool preparation${SOFT_SEP}Needs you${SOFT_SEP}runner trust`);
    expect(confirmPanelMinRows(request, wrapping)).toBe(confirmPanelMinRows(request, short) + 1);
    expect(getConfirmPanelRows(request, wrapping)).toBe(getConfirmPanelRows(request, short) + 1);
    const boxRows = confirmPanelMinRows(request, wrapping);
    // The border and both title rows stay the card's; the panel takes the rest.
    expect(
      fitConfirmPanel({ actionClass: 'runner_trust', actionDescription, frame: wrapping, boxRows })
        .bodyRows,
    ).toBe(boxRows - 4);
  });

  it('drops the irreversible note, then the label, and keeps the file over both', () => {
    const destructive = (boxRows: number) =>
      fitConfirmPanel({
        actionClass: 'destructive',
        actionDescription: '.splitbrief/state.json',
        frame: ownConfirmFrame(getChromeContentWidth(120)),
        boxRows,
      });
    expect(destructive(8)).toMatchObject({ framed: false, note: true, label: true, hidden: 0 });
    expect(destructive(7)).toMatchObject({ note: false, label: true, hidden: 0 });
    expect(destructive(6)).toMatchObject({
      note: false,
      label: false,
      subject: ['.splitbrief/state.json'],
      hidden: 1,
      markRow: false,
      gaps: { options: false, legend: false },
    });
  });

  it('drops the label before any disclosure line and lets the title count it', () => {
    expect(fitIn(9)).toMatchObject({
      label: false,
      subject: expect.arrayContaining(['A: one', 'C: three']),
      hidden: 1,
      markRow: false,
    });
  });

  it('cuts whole lines from the bottom, counts them on a row under them, and keeps a blank row above the options', () => {
    expect(fitIn(8)).toMatchObject({
      title: true,
      label: true,
      subject: ['A: one'],
      hidden: 4,
      markRow: true,
      gaps: { options: true, legend: false },
      options: 2,
      legend: true,
    });
  });

  it('lets the title carry the count when a count row and its blank row leave no line, and gives a free row to the label', () => {
    expect(fitIn(6)).toMatchObject({
      label: true,
      subject: ['A: one'],
      hidden: 4,
      markRow: false,
      gaps: { options: false, legend: false },
    });
  });

  it('gives the last free row to the first line, lets the title carry the count, then drops the legend before the title', () => {
    expect(fitIn(5)).toMatchObject({
      label: false,
      subject: ['A: one'],
      hidden: 5,
      markRow: false,
      legend: true,
    });
    expect(fitIn(4)).toMatchObject({
      title: true,
      label: false,
      subject: ['A: one'],
      hidden: 5,
      markRow: false,
      options: 2,
      legend: false,
    });
    expect(fitIn(3)).toMatchObject({
      title: false,
      subject: ['A: one'],
      options: 2,
      legend: false,
    });
  });

  it('drops the title last and paints only the option rows the region holds', () => {
    expect(fitIn(2)).toMatchObject({
      title: false,
      subject: ['A: one'],
      options: 1,
      legend: false,
    });
    expect(fitIn(1)).toMatchObject({ title: false, subject: [], options: 1, legend: false });
  });

  const longPath =
    'write src/features/workflow/components/approval-prompt/confirm-panel-long-name.tsx';
  const fitLongPath = (boxRows: number) =>
    fitConfirmPanel({
      actionClass: 'write_out_of_scope',
      actionDescription: longPath,
      frame: ownConfirmFrame(getChromeContentWidth(60)),
      boxRows,
    });

  it.each([2, 3, 4, 5, 6])('keeps the path beside the verb in a panel of %i rows', (boxRows) => {
    expect(fitLongPath(boxRows)).toMatchObject({
      subject: ['write src/features/workflow/components/approval-promp…'],
      hidden: 2,
    });
  });

  it('shows the end of the path on the second row of a panel of 7 rows', () => {
    expect(fitLongPath(7)).toMatchObject({
      subject: [
        'write src/features/workflow/components/approval-prompt',
        '/confirm-panel-long-name.tsx',
      ],
      hidden: 1,
    });
  });

  it('keeps the path segments whole when the whole line fits', () => {
    expect(fitLongPath(8)).toMatchObject({
      subject: [
        'write',
        'src/features/workflow/components/approval-prompt/',
        'confirm-panel-long-name.tsx',
      ],
      hidden: 1,
    });
  });
});
