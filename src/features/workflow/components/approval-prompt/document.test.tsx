import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { listRowLead } from '../../../../components/list-row.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import {
  REVIEW_COMMENT_HINTS,
  REVIEW_DOCUMENT_HINTS,
  getReviewDocumentPromptRows,
} from '../../prompt-rows/approval.js';
import { getReviewPanelBudget } from '../../layout/rect.js';
import { DocumentReviewPrompt } from './document.js';

afterEach(() => {
  terminalSizeStore.reset();
});

function frameOf(node: React.ReactElement): string {
  const ui = renderFeature(node);
  const frame = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return frame;
}

describe('DocumentReviewPrompt', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
  });

  it('names the build as the step plan approval releases', () => {
    const frame = frameOf(
      <DocumentReviewPrompt
        artifact="plan"
        confirms={[]}
        budgetRows={40}
        selectedIndex={0}
        commenting={false}
      />,
    );

    expect(frame).toContain('Approve plan and start the build');
    expect(frame).toContain('End run (close this run)');
    expect(frame).not.toContain('keep changes');
  });

  it('teaches the selection keys once, inside its own border', () => {
    const frame = frameOf(
      <DocumentReviewPrompt
        artifact="plan"
        confirms={[]}
        budgetRows={40}
        selectedIndex={0}
        commenting={false}
      />,
    );

    expect(frame).toContain(REVIEW_DOCUMENT_HINTS);
    expect(frame.split('↑↓ select').length - 1).toBe(1);
  });

  it('leads the highlighted row with the shared active lead', () => {
    const frame = frameOf(
      <DocumentReviewPrompt
        artifact="plan"
        confirms={[]}
        budgetRows={40}
        selectedIndex={0}
        commenting={false}
      />,
    );

    expect(frame).toContain(REVIEW_DOCUMENT_HINTS);
    expect(frame).toContain(`${listRowLead('active')}Approve plan and start the build`);
  });

  // The composer holds the keyboard at the plan card, so a letter types into the draft: a row that
  // advertised one would teach a key that does not exist.
  it('advertises no letter on any row', () => {
    const frame = frameOf(
      <DocumentReviewPrompt
        artifact="plan"
        confirms={[]}
        budgetRows={40}
        selectedIndex={0}
        commenting={false}
      />,
    );

    for (const letter of ['y', 'c', 'e', 'q']) {
      expect(frame).not.toMatch(new RegExp(`(^|\\s)${letter}\\s{3}[A-Z]`, 'm'));
    }
  });

  it('shows no highlight while a comment is being typed', () => {
    const frame = frameOf(
      <DocumentReviewPrompt
        artifact="plan"
        confirms={[]}
        budgetRows={40}
        selectedIndex={1}
        commenting
      />,
    );

    expect(frame).not.toContain(listRowLead('active'));
  });

  it('names only the live keys once a comment is being typed', () => {
    const frame = frameOf(
      <DocumentReviewPrompt
        artifact="plan"
        confirms={[]}
        budgetRows={40}
        selectedIndex={1}
        commenting
      />,
    );

    expect(frame).toContain(REVIEW_COMMENT_HINTS);
    expect(frame).not.toContain('c comment');
  });

  it('paints exactly the rows the layout budgeted for it', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 40, isSmall: false });
    const frame = frameOf(
      <DocumentReviewPrompt
        artifact="plan"
        confirms={[]}
        budgetRows={40}
        selectedIndex={0}
        commenting={false}
      />,
    );

    expect(frame.split('\n').length).toBe(getReviewDocumentPromptRows('plan', [], 80, 40));
  });

  describe('at 60×18, where the plan keeps one row', () => {
    const budgetRows = getReviewPanelBudget({ rows: 18, inputRows: 3 });

    function shortFrame(confirms: string[], commenting: boolean): string {
      terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: false });
      return frameOf(
        <DocumentReviewPrompt
          artifact="plan"
          confirms={confirms}
          budgetRows={budgetRows}
          selectedIndex={0}
          commenting={commenting}
        />,
      );
    }

    it('gives the legend row to what approving confirms', () => {
      const frame = shortFrame(['write package.json'], false);

      expect(frame).toContain('Approving also confirms: write package.json');
      expect(frame).not.toContain(REVIEW_DOCUMENT_HINTS);
      expect(frame.split('\n').length).toBe(budgetRows);
    });

    it('counts what approving confirms when the list would take a second row', () => {
      const frame = shortFrame(['write package.json', 'write .github/workflows/ci.yml'], false);

      expect(frame).toContain('Approving also confirms 2 protected operations');
      expect(frame).not.toContain('ci.yml');
      expect(frame.split('\n').length).toBe(budgetRows);
    });

    it('teaches the live keys in that row while a comment is typed', () => {
      const frame = shortFrame(['write package.json'], true);

      expect(frame).toContain(REVIEW_COMMENT_HINTS);
      expect(frame).not.toContain('Approving also confirms');
      expect(frame.split('\n').length).toBe(budgetRows);
    });
  });

  it.each([60, 80, 120])(
    'keeps what approving confirms above the rows, in the rows budgeted at %i columns',
    (cols) => {
      terminalSizeStore.__testReset({ cols, rows: 40, isSmall: false });
      const confirms = ['write package.json', 'write .github/workflows/ci.yml'];
      const frame = frameOf(
        <DocumentReviewPrompt
          artifact="plan"
          confirms={confirms}
          budgetRows={40}
          selectedIndex={0}
          commenting={false}
        />,
      );

      expect(frame.replace(/[\s│┃]+/g, ' ')).toContain(
        'Approving also confirms: write package.json, write .github/workflows/ci.yml',
      );
      expect(frame.indexOf('Approving also confirms')).toBeLessThan(frame.indexOf('Approve plan'));
      expect(frame.split('\n').length).toBe(
        getReviewDocumentPromptRows('plan', confirms, cols, 40),
      );
    },
  );
});
