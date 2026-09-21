import { afterEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { cursorGlyph } from '../../../../components/pickers/cursor-glyph.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import {
  REVIEW_COMMENT_HINTS,
  REVIEW_DOCUMENT_HINTS,
  getReviewDocumentPromptRows,
} from '../../prompt-rows/approval.js';
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
  it.each([
    ['spec', 'Approve spec and write the plan'],
    ['plan', 'Approve plan and compile briefs'],
    ['briefs', 'Approve briefs and start the build'],
  ] as const)('names the step %s approval releases', (artifact, row) => {
    const frame = frameOf(
      <DocumentReviewPrompt artifact={artifact} selectedIndex={0} commenting={false} />,
    );

    expect(frame).toContain(row);
    expect(frame).toContain('End run (close this run; keep changes)');
  });

  it('teaches the selection keys once, inside its own border', () => {
    const frame = frameOf(
      <DocumentReviewPrompt artifact="plan" selectedIndex={0} commenting={false} />,
    );

    expect(frame).toContain(REVIEW_DOCUMENT_HINTS);
    expect(frame.split('↑↓ select').length - 1).toBe(1);
  });

  it('gates the briefs with the same cursor and legend as the plan', () => {
    const frame = frameOf(
      <DocumentReviewPrompt artifact="briefs" selectedIndex={0} commenting={false} />,
    );

    expect(frame).toContain(REVIEW_DOCUMENT_HINTS);
    expect(frame).toContain(`${cursorGlyph()}y   Approve briefs and start the build`);
  });

  it('names only the live keys once a comment is being typed', () => {
    const frame = frameOf(<DocumentReviewPrompt artifact="plan" selectedIndex={1} commenting />);

    expect(frame).toContain(REVIEW_COMMENT_HINTS);
    expect(frame).not.toContain('c comment');
  });

  it('paints exactly the rows the layout budgeted for it', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 40, isSmall: false });
    const frame = frameOf(
      <DocumentReviewPrompt artifact="plan" selectedIndex={0} commenting={false} />,
    );

    expect(frame.split('\n').length).toBe(getReviewDocumentPromptRows('plan', 80));
  });
});
