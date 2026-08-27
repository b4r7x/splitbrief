import { afterEach, describe, expect, it } from 'vitest';
import { Box } from 'ink';
import { renderFeature } from '#testing/helpers/ink.js';
import type { CheckpointSummaryRollup } from '../../../core/schemas/summary.js';
import { useTheme } from '../../../components/theme.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { buildCheckpointDetailRows } from './checkpoints.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const checkpointSummary: CheckpointSummaryRollup = {
  count: 3,
  latestId: 'snap-post-2',
  latestName: 'post-task-2',
  latestKind: 'post-task',
  latestRunCheckpointId: 'snap-post-2',
  preFinalReviewId: 'snap-pre-final',
  accepted: true,
  rejected: false,
  diffCommand: 'splitbrief snapshot diff snap-post-2 --from-rollup',
  restoreCommand: 'splitbrief snapshot restore snap-post-2 --from-rollup',
};

function CheckpointRows({
  checkpointSummary,
  isSmall = false,
}: {
  checkpointSummary: CheckpointSummaryRollup;
  isSmall?: boolean;
}) {
  const theme = useTheme();
  const rows = buildCheckpointDetailRows(checkpointSummary, isSmall, theme);
  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <Box key={row.key}>{row.node}</Box>
      ))}
    </Box>
  );
}

describe('buildCheckpointDetailRows', () => {
  afterEach(() => {
    terminalSizeStore.__testReset();
  });

  it('renders checkpoint count, latest checkpoint, pre-final checkpoint, commands, and safety copy', () => {
    terminalSizeStore.__testReset({ cols: 160, isSmall: false });

    const ui = renderFeature(<CheckpointRows checkpointSummary={checkpointSummary} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Checkpoints');
    expect(frame).toContain('3 checkpoints');
    expect(frame).toContain('latest');
    expect(frame).toContain('post-task');
    expect(frame).toContain('snap-post-2');
    expect(frame).toContain('pre-final-review');
    expect(frame).toContain('snap-pre-final');
    expect(frame).toContain('run status: accepted');
    expect(frame).toContain('splitbrief snapshot diff snap-post-2 --from-rollup');
    expect(frame).toContain('splitbrief snapshot restore snap-post-2 --from-rollup');
    expect(frame).toContain('hash-guarded');
    expect(frame).toContain('conflicts skipped');
    expect(frame).toContain('--force');
    expect(frame).toContain('destructive');

    ui.unmount();
  });

  it('renders rejected run status when the ledger rollup rejected the run', () => {
    terminalSizeStore.__testReset({ cols: 160, isSmall: false });

    const ui = renderFeature(
      <CheckpointRows
        checkpointSummary={{
          ...checkpointSummary,
          accepted: false,
          rejected: true,
        }}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('run status: rejected');
    expect(frame).not.toContain('run status: accepted');

    ui.unmount();
  });

  it('uses ID-based fallback commands when command rollups are missing', () => {
    const ui = renderFeature(
      <CheckpointRows
        checkpointSummary={{
          ...checkpointSummary,
          diffCommand: null,
          restoreCommand: null,
        }}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('splitbrief snapshot diff snap-post-2');
    expect(frame).toContain('splitbrief snapshot restore snap-post-2');
    expect(frame).not.toContain('--from-rollup');

    ui.unmount();
  });

  it('keeps the small-terminal latest checkpoint line ID-focused', () => {
    const longName = `pre-final-review-${'x'.repeat(80)}`;
    terminalSizeStore.__testReset({ isSmall: true });

    const ui = renderFeature(
      <CheckpointRows
        isSmall
        checkpointSummary={{
          ...checkpointSummary,
          latestName: longName,
        }}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain(longName);
    expect(frame).toContain('latest: snap-post-2');
    expect(frame).toContain('splitbrief snapshot diff snap-post-2');

    ui.unmount();
  });

  it('strips terminal-control bytes from persisted checkpoint fields before render', () => {
    terminalSizeStore.__testReset({ cols: 160, isSmall: false });

    const ui = renderFeature(
      <CheckpointRows
        checkpointSummary={{
          ...checkpointSummary,
          latestId: `snap${ESC}]52;c;clip-id${BEL}-9`,
          latestName: `post${ESC}[31m-task`,
          preFinalReviewId: `snap-pre${ESC}]52;c;clip-pre${BEL}`,
          latestRunCheckpointId: `snaprun${ESC}]52;c;clip-run${BEL}-9`,
          diffCommand: `splitbrief snapshot diff ${ESC}]52;c;clip-diff${BEL}snap-9`,
          restoreCommand: null,
        }}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('snap');
    expect(frame).not.toContain('clip-id');
    expect(frame).not.toContain('clip-pre');
    expect(frame).not.toContain('clip-run');
    expect(frame).not.toContain('clip-diff');
    expect(frame).not.toContain('52;c');

    ui.unmount();
  });
});
