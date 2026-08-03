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
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../prompt-grace.js';

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
    expect(output).toContain('approve?');
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

  it('renders store-driven prediction and settles the open promise on close (attached IPC path)', async () => {
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

  it('splits the approve/reject row into two full-height halves (calibration)', () => {
    const zones = getCostApprovalButtonZones({
      boxTop: 10,
      cols: 200,
      promptRows: 30,
      prediction: makeCostPrediction(),
    });
    expect(zones).not.toBeNull();
    // boxTop(10) + border(1) + pad(1) + header(1) + comparison(3) + scope(1) + scopeBlank(1)
    //   + gap(1) = approve/reject row 19.
    expect(zones?.approve).toMatchObject({ left: 1, right: 100, top: 19, bottom: 19 });
    expect(zones?.reject).toMatchObject({ left: 101, right: 200, top: 19, bottom: 19 });
  });

  it('collapses to a numberless approve/reject row when the summary is unpriced (calibration)', () => {
    const zones = getCostApprovalButtonZones({
      boxTop: 10,
      cols: 200,
      promptRows: 7,
      prediction: makeCostPrediction({ deterministic: undefined }),
    });
    expect(zones).not.toBeNull();
    // boxTop(10) + border(1) + pad(1) + gap(1) = numberless approve/reject row 13 (no data rows).
    expect(zones?.approve).toMatchObject({ left: 1, right: 100, top: 13, bottom: 13 });
    expect(zones?.reject).toMatchObject({ left: 101, right: 200, top: 13, bottom: 13 });
  });

  it('returns null when the row would fall below the clamped prompt box', () => {
    const zones = getCostApprovalButtonZones({
      boxTop: 10,
      cols: 200,
      promptRows: 5,
      prediction: makeCostPrediction(),
    });
    expect(zones).toBeNull();
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
    if (!zones) throw new Error('expected zones');

    hitTopmostZone(40, zones.approve.top)?.onClick?.();
    hitTopmostZone(150, zones.reject.top)?.onClick?.();
    hitTopmostZone(40, zones.approve.top - 1)?.onClick?.();

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
    const approveRow = lines.findIndex((line) => line.includes('approve?'));
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
    const approveRow = lines.findIndex((line) => line.includes('approve?'));
    expect(approveRow).toBe(
      getCostApprovalButtonRowOffset(makeCostPrediction({ deterministic: undefined }), boxWidth),
    );
    // The numberless gate has no header/comparison/scope rows: border + pad + gap = row 3.
    expect(approveRow).toBe(3);
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
