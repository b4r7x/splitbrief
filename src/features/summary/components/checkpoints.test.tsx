import { afterEach, describe, expect, it } from 'vitest';
import { renderFeature } from '../../../../testing/helpers/ink.js';
import type { CheckpointSummaryRollup } from '../../../core/schemas/summary.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { SummaryCheckpoints } from './checkpoints.js';

const checkpointSummary: CheckpointSummaryRollup = {
  count: 3,
  latestId: 'snap-post-2',
  latestName: 'post-task-2',
  latestKind: 'post-task',
  latestRunCheckpointId: 'snap-post-2',
  preFinalReviewId: 'snap-pre-final',
  accepted: true,
  rejected: false,
  diffCommand: 'diptych snapshot diff snap-post-2',
  restoreCommand: 'diptych snapshot restore snap-post-2',
};

describe('SummaryCheckpoints', () => {
  afterEach(() => {
    terminalSizeStore.__testReset();
  });

  it('renders nothing when no checkpoint rollup exists', () => {
    const ui = renderFeature(<SummaryCheckpoints checkpointSummary={undefined} />);

    expect(ui.lastFrame() ?? '').toBe('');

    ui.unmount();
  });

  it('renders checkpoint count, latest checkpoint, pre-final checkpoint, commands, and safety copy', () => {
    terminalSizeStore.__testReset({ cols: 160, isSmall: false });

    const ui = renderFeature(<SummaryCheckpoints checkpointSummary={checkpointSummary} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Checkpoints');
    expect(frame).toContain('3 checkpoints');
    expect(frame).toContain('latest');
    expect(frame).toContain('post-task');
    expect(frame).toContain('snap-post-2');
    expect(frame).toContain('pre-final-review');
    expect(frame).toContain('snap-pre-final');
    expect(frame).toContain('run status: accepted');
    expect(frame).toContain('diptych snapshot diff snap-post-2');
    expect(frame).toContain('diptych snapshot restore snap-post-2');
    expect(frame).toContain('hash-guarded');
    expect(frame).toContain('conflicts skipped');
    expect(frame).toContain('--force');
    expect(frame).toContain('destructive');

    ui.unmount();
  });

  it('renders rejected run status when the ledger rollup rejected the run', () => {
    terminalSizeStore.__testReset({ cols: 160, isSmall: false });

    const ui = renderFeature(
      <SummaryCheckpoints
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
      <SummaryCheckpoints
        checkpointSummary={{
          ...checkpointSummary,
          diffCommand: null,
          restoreCommand: null,
        }}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('diptych snapshot diff snap-post-2');
    expect(frame).toContain('diptych snapshot restore snap-post-2');

    ui.unmount();
  });

  it('keeps the small-terminal latest checkpoint line ID-focused', () => {
    const longName = `pre-final-review-${'x'.repeat(80)}`;
    terminalSizeStore.__testReset({ isSmall: true });

    const ui = renderFeature(
      <SummaryCheckpoints
        checkpointSummary={{
          ...checkpointSummary,
          latestName: longName,
        }}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain(longName);
    expect(frame).toContain('latest: snap-post-2');
    expect(frame).toContain('diptych snapshot diff snap-post-2');

    ui.unmount();
  });
});
