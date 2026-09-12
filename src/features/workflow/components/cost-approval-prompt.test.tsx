import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeCostPrediction } from '#testing/helpers/factories/cost-prediction.js';
import {
  getCostApprovalButtonRowOffset,
  getCostApprovalPromptRowsForPrediction,
} from '../prompt-rows/cost.js';
import {
  CostApprovalPrompt,
  CostApprovalPromptConnected,
  getCostApprovalButtonZones,
} from './cost-approval-prompt.js';
import { _resetMouseZones, hitTopmostZone } from '../../../lib/terminal/mouse-zones.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import {
  closeCostApprovalPrompt,
  costApprovalStore,
  openCostApprovalPrompt,
} from '../../../stores/cost-approval/prompt.js';
import { readConversationScrollSnapshot } from '../layout/snapshot.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../lib/terminal/typeahead-grace.js';

const PAST_GRACE = PROMPT_TYPEAHEAD_GRACE_MS + 30;

describe('CostApprovalPrompt', () => {
  beforeEach(() => {
    overlayStore.reset();
  });

  afterEach(() => {
    overlayStore.reset();
  });

  it('renders task count and cost estimate', () => {
    const ui = renderFeature(
      <CostApprovalPrompt
        prediction={makeCostPrediction()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    const output = ui.lastFrame() ?? '';
    expect(output).toContain('12 tasks');
    expect(output).toContain('prompt input');
    expect(output).toContain('$0.14');
    expect(output).toContain('all-planner prompt');
    expect(output).toContain('~$1.20');
    expect(output).toContain('prompt saving');
    expect(output).toContain(
      'output, retries, validation reruns, and escalation tracked at runtime',
    );
    expect(output).toContain('y   Approve');
    expect(output).toContain('x   Deny');
    expect(output).not.toContain('Est.');
    ui.unmount();
  });

  it('renders an all-planner baseline when the actual estimate is unknown', () => {
    const prediction = makeCostPrediction();
    prediction.deterministic!.totals.knownActualEstimate = null;
    prediction.deterministic!.totals.estimatedSavings = null;

    const ui = renderFeature(
      <CostApprovalPrompt prediction={prediction} onApprove={vi.fn()} onReject={vi.fn()} />,
    );
    const output = ui.lastFrame() ?? '';

    expect(output).toContain('prompt input');
    expect(output).toContain('n/a');
    expect(output).toContain('all-planner prompt');
    expect(output).toContain('~$1.20');
    ui.unmount();
  });

  it('approves the cost gate when y is pressed after the typeahead grace', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const ui = renderFeature(
      <CostApprovalPrompt
        prediction={makeCostPrediction()}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    await tick(PAST_GRACE);
    await flushEffects();
    ui.stdin.write('y');
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onReject).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('rejects the cost gate when n is pressed after the typeahead grace', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const ui = renderFeature(
      <CostApprovalPrompt
        prediction={makeCostPrediction()}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    await tick(PAST_GRACE);
    await flushEffects();
    ui.stdin.write('n');
    expect(onReject).toHaveBeenCalledOnce();
    expect(onApprove).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('ignores a keystroke that lands inside the typeahead grace window', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const ui = renderFeature(
      <CostApprovalPrompt
        prediction={makeCostPrediction()}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    // A 'y' buffered for the composer arrives the instant the cost prompt mounts. The grace
    // swallows it so a stray keystroke cannot auto-approve a spend the user never confirmed.
    await flushEffects();
    ui.stdin.write('y');
    await tick(1);
    expect(onApprove).not.toHaveBeenCalled();

    await tick(PAST_GRACE);
    await flushEffects();
    ui.stdin.write('y');
    expect(onApprove).toHaveBeenCalledOnce();
    ui.unmount();
  });

  it('does not approve while an overlay is open, honours the key after it closes', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    overlayStore.open('settings');
    const ui = renderFeature(
      <CostApprovalPrompt
        prediction={makeCostPrediction()}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    await tick(PAST_GRACE);

    // The prompt is hidden behind the overlay; an approve key aimed at the overlay must not
    // confirm the buried spend.
    await flushEffects();
    ui.stdin.write('y');
    await tick(1);
    expect(onApprove).not.toHaveBeenCalled();

    // Closing the overlay returns input to the prompt and the same key is honoured.
    overlayStore.close();
    await flushEffects();
    ui.stdin.write('y');
    expect(onApprove).toHaveBeenCalledOnce();
    ui.unmount();
  });
});

describe('CostApprovalPromptConnected', () => {
  afterEach(() => {
    costApprovalStore.__testReset();
  });

  it('renders the store-driven prediction and settles the open promise on close', async () => {
    const pending = openCostApprovalPrompt(makeCostPrediction());
    const ui = renderFeature(<CostApprovalPromptConnected />);

    expect(ui.lastFrame() ?? '').toContain('prompt saving');

    closeCostApprovalPrompt({ approved: false });
    expect(await pending).toBe(false);
    ui.unmount();
  });
});

describe('cost approve/reject click zones', () => {
  afterEach(() => {
    _resetMouseZones();
  });

  it('keeps both narrow option rows visible and clickable inside the computed box', async () => {
    const cols = 10;
    const prediction = makeCostPrediction();
    terminalSizeStore.__testReset({ cols, rows: 80, isSmall: true });
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const ui = renderFeature(
      <CostApprovalPrompt prediction={prediction} onApprove={onApprove} onReject={onReject} />,
      { cols, rows: 80 },
    );
    await flushEffects();

    const promptRows = getCostApprovalPromptRowsForPrediction(prediction, cols);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('> y');
    expect(frame).toContain('  x');

    const zones = getCostApprovalButtonZones({
      boxTop: 10,
      cols,
      promptRows,
      prediction,
    });
    expect(zones).toHaveLength(2);
    expect(zones.every((zone) => zone.bottom <= 10 + promptRows - 1)).toBe(true);

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('stacks the options as full-width rows like every sibling gate (calibration)', () => {
    const zones = getCostApprovalButtonZones({
      boxTop: 10,
      cols: 200,
      promptRows: 30,
      prediction: makeCostPrediction(),
    });
    // boxTop(10) + border(1) + title(1) + pad(1) + header(1) + comparison(3) + scope(1)
    //   + gap(1) = approve row 19, deny row 20; both span the panel.
    expect(zones).toEqual([
      { key: 'y', left: 1, right: 200, top: 19, bottom: 19 },
      { key: 'x', left: 1, right: 200, top: 20, bottom: 20 },
    ]);
  });

  it('collapses to a numberless option pair when the summary is unpriced (calibration)', () => {
    const zones = getCostApprovalButtonZones({
      boxTop: 10,
      cols: 200,
      promptRows: 10,
      prediction: makeCostPrediction({ deterministic: undefined }),
    });
    // boxTop(10) + border(1) + title(1) + pad(1) + gap(1) = approve row 14, deny row 15.
    expect(zones.map((zone) => zone.top)).toEqual([14, 15]);
  });

  it('drops option rows that would fall below the clamped prompt box', () => {
    const zones = getCostApprovalButtonZones({
      boxTop: 10,
      cols: 200,
      promptRows: 5,
      prediction: makeCostPrediction(),
    });
    expect(zones).toEqual([]);
  });

  it('fires approve and reject callbacks when the rendered click zones are hit', async () => {
    terminalSizeStore.__testReset({ cols: 200, rows: 24, isSmall: false });
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const prediction = makeCostPrediction();
    const ui = renderFeature(
      <CostApprovalPrompt prediction={prediction} onApprove={onApprove} onReject={onReject} />,
    );
    await tick(1);

    const { contentRect } = readConversationScrollSnapshot();
    const boxTop = contentRect.top + contentRect.height;
    const zones = getCostApprovalButtonZones({
      boxTop,
      cols: 200,
      promptRows: getCostApprovalPromptRowsForPrediction(prediction, 200),
      prediction,
    });
    const [approve, deny] = zones;
    if (!approve || !deny) throw new Error('expected two cost option zones');

    hitTopmostZone(40, approve.top)?.onClick?.();
    hitTopmostZone(150, deny.top)?.onClick?.();
    hitTopmostZone(40, approve.top - 1)?.onClick?.();

    expect(onApprove).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledOnce();
    ui.unmount();
    terminalSizeStore.reset();
  });
});

describe('cost gate render aligns to the computed button offset', () => {
  it('renders the populated approve row exactly at the computed button offset', () => {
    const ui = renderFeature(
      <CostApprovalPrompt
        prediction={makeCostPrediction()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const boxWidth = lines[0]?.length ?? 0;
    const approveRow = lines.findIndex((line) => line.includes('Approve'));
    expect(approveRow).toBe(getCostApprovalButtonRowOffset(makeCostPrediction(), boxWidth));
    ui.unmount();
  });

  it('renders the unpriced numberless approve row exactly at the computed button offset', () => {
    const ui = renderFeature(
      <CostApprovalPrompt
        prediction={makeCostPrediction({ deterministic: undefined })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const lines = frame.split('\n');
    const boxWidth = lines[0]?.length ?? 0;
    const approveRow = lines.findIndex((line) => line.includes('Approve'));
    expect(approveRow).toBe(
      getCostApprovalButtonRowOffset(makeCostPrediction({ deterministic: undefined }), boxWidth),
    );
    // The numberless gate has no header/comparison/scope rows: border + title + pad + gap = row 4.
    expect(approveRow).toBe(4);
    expect(frame).toContain('x   Deny');
    // No fabricated figures leak into the collapsed gate.
    expect(frame).not.toContain('$');
    expect(frame).not.toContain('tasks');
    ui.unmount();
  });
});

describe('short-viewport clamp clips registered cost zones', () => {
  beforeEach(() => {
    _resetMouseZones();
    overlayStore.reset();
    terminalSizeStore.__testReset({ cols: 200, rows: 24, isSmall: false });
  });

  afterEach(() => {
    _resetMouseZones();
    overlayStore.reset();
    terminalSizeStore.reset();
  });

  it('does not activate approve/reject zones below the shell-clamped prompt box', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const ui = renderFeature(
      <CostApprovalPrompt
        prediction={makeCostPrediction()}
        onApprove={onApprove}
        onReject={onReject}
        clampedBoxRows={8}
      />,
    );
    await tick(1);

    const { contentRect } = readConversationScrollSnapshot();
    const boxTop = contentRect.top + contentRect.height;

    // The approve/reject row would render at boxTop + 8, below the clamped box bottom
    // (boxTop + 7), where overflow="hidden" hides it — no zone may be registered there.
    const hit = hitTopmostZone(40, boxTop + 8);
    hit?.onClick?.();
    expect(hit).toBeUndefined();
    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();

    ui.unmount();
  });
});
