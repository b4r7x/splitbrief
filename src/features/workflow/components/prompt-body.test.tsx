import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { PromptBody } from './prompt-body.js';
import { countPromptBodyRows } from '../prompt-body-rows.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';

const RECOVERY_PROMPT = [
  'recovery needed · validation failed after 2 attempts',
  '',
  'task t3 · add session middleware',
  'files src/auth/session.ts',
  '',
  '▌ [space]  pause · no new brief starts, changes kept',
  '[r] retry same worker',
  '[b] route to bigger worker · claude-sonnet',
  '[a] abort',
].join('\n');

const CONFLICT_PROMPT = [
  'recovery needed · your edits conflict with t4',
  '',
  'task t4 · wire login route',
  '',
  '▌ [p] ask planner to rebase on your edits',
  '(approve / edit / reject the proposal)',
  '[r] retry same worker',
].join('\n');

const REVIEW_PROMPT = [
  '✓ t3 ready for review · add session middleware',
  '',
  'status passed',
  'checks 3/3 green',
  '',
  '▌ [c] continue',
  '[a] abort',
].join('\n');

const FAILED_REVIEW_PROMPT = [
  't3 failed review · add session middleware',
  '',
  'status failed',
  'checks 1/3 green',
  '',
  '▌ [r] redo task',
  '[a] abort',
].join('\n');

describe('PromptBody', () => {
  beforeEach(() => {
    process.env.TERM = 'xterm-256color';
    process.env.LANG = 'en_US.UTF-8';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  it('paints the dim key column and marks the recommended row with words, without a bar', () => {
    const ui = render(<PromptBody prompt={RECOVERY_PROMPT} height={20} width={60} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const pauseRow = frame.split('\n').find((line) => line.includes('pause'));

    expect(frame).not.toContain('▌');
    expect(pauseRow).toBe('  space   pause recommended');
    expect(pauseRow).not.toContain('…');
    expect(frame).toContain('  r       retry same worker');
    expect(frame).toContain('  a       abort');
  });

  it('renders the rebase tail as a separate indented continuation line', () => {
    const ui = render(<PromptBody prompt={CONFLICT_PROMPT} height={20} width={70} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('p   ask planner to rebase on your edits');
    expect(frame).toContain('      (approve / edit / reject the proposal)');
  });

  it('keeps the passing review headline with its ✓ marker', () => {
    const ui = render(<PromptBody prompt={REVIEW_PROMPT} height={20} width={70} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('✓ t3 ready for review · add session middleware');
    expect(frame).toContain('c   continue recommended');
  });

  it('keeps the failed review headline word and cause readable', () => {
    const ui = render(<PromptBody prompt={FAILED_REVIEW_PROMPT} height={20} width={70} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('t3 failed review · add session middleware');
    expect(frame).toContain('r   redo task recommended');
  });

  // The panel is sized from countPromptBodyRows, so a row that paints taller than the model
  // measured costs a row above it: at 76 columns the recommended tail used to wrap onto its own
  // line and the headline lost its first cell, at 56 it lost the whole row.
  it('paints exactly the rows the model measured, headline first, at every width', () => {
    for (const width of [116, 76, 56, 32]) {
      for (const height of [countPromptBodyRows(RECOVERY_PROMPT, width), 6]) {
        const ui = render(<PromptBody prompt={RECOVERY_PROMPT} height={height} width={width} />);
        const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');

        expect(lines).toHaveLength(height);
        expect(lines[0]).toContain('recovery needed');
        expect(lines.filter((line) => line.includes('recommended'))).toHaveLength(1);

        ui.unmount();
      }
    }
  });

  it('renders nothing when height is non-positive', () => {
    const ui = render(<PromptBody prompt={RECOVERY_PROMPT} height={0} width={70} />);
    expect(ui.lastFrame() ?? '').toBe('');
  });
});
