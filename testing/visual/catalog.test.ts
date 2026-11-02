import { relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_OVERLAYS, ALL_SCREENS } from '../../src/core/navigation/types.js';
import { formatAttachmentFailure } from '../../src/core/attachments/failure.js';
import type { InputFileFailureReason } from '../../src/core/attachments/resolve.js';
import { configStore } from '../../src/stores/project/config.js';
import { routerStore } from '../../src/stores/navigation/router.js';
import { composerLiveStore } from '../../src/stores/ui/composer-live.js';
import { feedbackStore } from '../../src/stores/ui/feedback.js';
import { stripTerminalControls } from '../../src/utils/display-text.js';
import { selectRailForm } from '../../src/features/workflow/layout/chrome-rows.js';
import {
  listVisualScenarios,
  findVisualScenario,
  REQUIRED_VIEWPORTS,
  WIDE_VIEWPORTS,
  REQUIRED_WORKFLOW_CHECKPOINT_IDS,
  REQUIRED_WORKFLOW_CHECKPOINT_KINDS,
  VISUAL_CATALOG,
  VISUAL_CATALOG_VERSION,
  VISUAL_FIXTURE_VERSION,
} from './catalog.js';
import { formatViewport, viewport } from './contracts/geometry.js';
import { checkpointId, scenarioId } from './contracts/identifiers.js';
import { overlayFixtureRegistry } from './fixtures/overlay-fixtures.js';
import { screenFixtureRegistry, VISUAL_FIXTURE_PROJECT_DIR } from './fixtures/screen-fixtures.js';
import {
  assertProjectionBounds,
  WORKFLOW_FIXTURE_BOUNDS,
} from './fixtures/workflow/projections.js';
import {
  workflowCheckpointPredicates,
  workflowFixtureRegistry,
  workflowTranscriptText,
} from './fixtures/workflow/registry.js';
import { mountGalleryScenario } from './gallery/mount.js';
import { editorHandoverScenarios } from './gallery/editor-handover.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function plainFrame(frame: string): string {
  return frame.replace(/[\u2500-\u257F]/g, ' ').replace(/\s+/g, ' ');
}

const CARD_TOP_LEFT = '\u256D';
const CARD_TOP_RIGHT = '\u256E';
const CARD_BOTTOM_LEFT = '\u2570';
const CARD_BOTTOM_RIGHT = '\u256F';
const CARD_HORIZONTAL = '\u2500';
const CARD_VERTICAL = '\u2502';
const CARD_EDGE = new Set([
  CARD_TOP_LEFT,
  CARD_TOP_RIGHT,
  CARD_BOTTOM_LEFT,
  CARD_BOTTOM_RIGHT,
  CARD_VERTICAL,
]);

function rightCardRows(frame: string): string[] {
  const lines = frame.split('\n');
  const span = rightCardSpan(lines);
  if (span === undefined) throw new Error('Right card borders are absent');
  return lines
    .slice(span.top + 1, span.bottom)
    .map((line) => line.slice(span.left + 1, span.right));
}

function rightCardText(frame: string): string {
  return rightCardRows(frame)
    .join('\n')
    .replace(/[\u2500-\u257F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rightCardSpan(
  lines: readonly string[],
): { left: number; right: number; top: number; bottom: number } | undefined {
  const horizontalRun = `${CARD_HORIZONTAL}*`;
  const pattern = new RegExp(
    [
      `${CARD_TOP_LEFT}${horizontalRun}${CARD_TOP_RIGHT}`,
      `${CARD_BOTTOM_LEFT}${horizontalRun}${CARD_BOTTOM_RIGHT}`,
      `${CARD_VERTICAL}[^${CARD_VERTICAL}]*${CARD_VERTICAL}`,
    ].join('|'),
    'gu',
  );
  let anchor: { left: number; right: number; row: number } | undefined;
  for (let row = 0; row < lines.length; row += 1) {
    pattern.lastIndex = 0;
    const boxes: Array<{ left: number; right: number }> = [];
    for (const match of (lines[row] ?? '').matchAll(pattern)) {
      const left = match.index;
      if (left === undefined) continue;
      boxes.push({ left, right: left + match[0].length - 1 });
    }
    const card = boxes.length < 2 ? undefined : boxes[boxes.length - 1];
    if (card === undefined) continue;
    anchor = { left: card.left, right: card.right, row };
    break;
  }
  if (anchor === undefined) return undefined;
  let top = anchor.row;
  while (top > 0 && cardEdge(lines[top - 1] ?? '', anchor.left, anchor.right)) top -= 1;
  let bottom = anchor.row;
  while (
    bottom + 1 < lines.length &&
    cardEdge(lines[bottom + 1] ?? '', anchor.left, anchor.right)
  ) {
    bottom += 1;
  }
  const topLine = lines[top] ?? '';
  const bottomLine = lines[bottom] ?? '';
  if (topLine[anchor.left] !== CARD_TOP_LEFT || topLine[anchor.right] !== CARD_TOP_RIGHT) {
    return undefined;
  }
  if (
    bottomLine[anchor.left] !== CARD_BOTTOM_LEFT ||
    bottomLine[anchor.right] !== CARD_BOTTOM_RIGHT
  ) {
    return undefined;
  }
  return { left: anchor.left, right: anchor.right, top, bottom };
}

function cardEdge(line: string, left: number, right: number): boolean {
  const start = line[left];
  const end = line[right];
  return start !== undefined && end !== undefined && CARD_EDGE.has(start) && CARD_EDGE.has(end);
}

function twoColumnFrame(leftLines: readonly string[], rightLines: readonly string[]): string {
  const columnWidth = (lines: readonly string[]): number =>
    lines.reduce((width, line) => Math.max(width, line.length), 0);
  const leftWidth = columnWidth(leftLines);
  const rightWidth = columnWidth(rightLines);
  const cap = (leftChar: string, rightChar: string, size: number): string =>
    `${leftChar}${CARD_HORIZONTAL.repeat(size)}${rightChar}`;
  const row = (text: string, size: number): string =>
    `${CARD_VERTICAL}${text.padEnd(size)}${CARD_VERTICAL}`;
  const joinColumns = (left: string, right: string): string => `${left}   ${right}`;
  const body = Array.from({ length: Math.max(leftLines.length, rightLines.length) }, (_, index) =>
    joinColumns(row(leftLines[index] ?? '', leftWidth), row(rightLines[index] ?? '', rightWidth)),
  );
  return [
    joinColumns(
      cap(CARD_TOP_LEFT, CARD_TOP_RIGHT, leftWidth),
      cap(CARD_TOP_LEFT, CARD_TOP_RIGHT, rightWidth),
    ),
    ...body,
    joinColumns(
      cap(CARD_BOTTOM_LEFT, CARD_BOTTOM_RIGHT, leftWidth),
      cap(CARD_BOTTOM_LEFT, CARD_BOTTOM_RIGHT, rightWidth),
    ),
  ].join('\n');
}

function expectConsecutiveToolRows(frame: string, names: readonly string[]): void {
  const lines = frame.split('\n');
  const start = lines.findIndex((line) => line.includes(names[0] ?? ''));
  if (start < 0 || names[0] === undefined) throw new Error('tool row missing');
  for (let offset = 0; offset < names.length; offset += 1) {
    const name = names[offset];
    if (name === undefined) throw new Error('tool row missing');
    expect(lines[start + offset], name).toContain(name);
  }
}

/** Scenarios whose surface cannot mount at the default matrix and say so in the catalog. */
const SCENARIO_VIEWPORT_EXCEPTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['workflow-review-resumed', ['120x40', '80x24', '60x18', '120x60']],
  ['workflow-cli-stop-continued', ['120x40', '80x24', '60x18', '120x60']],
  ['workflow-resumed-kept-work', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-paused-cut-seat', ['120x40', '80x24', '60x18', '160x45']],
  ['home-empty', ['120x40', '80x24', '60x18', '41x18', '40x18']],
  ['home-cold-detecting', ['80x40', '120x40']],
  ['home-preparation-runner-trust', ['120x40', '80x24', '60x18', '42x30', '39x40']],
  ['home-cold-crew', ['120x40', '80x24', '60x18', '200x50']],
  ['workflow-crew-wide', ['120x40', '80x24', '60x18', '160x45', '200x50']],
  ['workflow-crew-kilo', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-seat-switched-balance', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-planning-seat-change', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-final-review-seat-change', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-plan-card-seat-change', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-implementation-seat-change', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-build-brief-check-seat-change', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-implementation-shell-seat', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-seat-crew-changed', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-review-fix-cycles', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-review-stuck-planner', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-review-corrected', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-review-settled-passed', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-review-settled-set-aside', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-review-settled-failed', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-review-task-cadence', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-review-task-cadence-settled', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-review-task-out-of-scope', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-complete-after-fix-tasks', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-review-fix-no-change', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-ready-to-apply', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-ready-crew-saved', ['120x40', '80x24', '60x18', '160x45', '200x50']],
  ['workflow-ready-seat-moved-auto', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-at-rest-crashed-build', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-at-rest-apply-conflict', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-at-rest-applying', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-at-rest-applying-home-queued', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-at-rest-applying-quit-queued', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-at-rest-other-process-applying', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-at-rest-other-process-applying-clock', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-continuous-transcript', ['120x40', '80x24', '60x18', '160x45', '200x50']],
  ['workflow-continuous-transcript-ready', ['120x40', '80x24', '60x18', '160x45', '200x50']],
  ['workflow-recovery-balance-spent', ['120x40', '80x24', '60x18', '160x45', '200x50']],
  ['workflow-recovery-cursor-refusal', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-recovery-route-signed-out', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-recovery-model-not-listed', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-recovery-model-refused', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-recovery-retry-exhausted', ['120x40', '80x24', '60x18', '140x16', '140x14', '140x12']],
  ['workflow-recovery-long-question', ['120x40', '80x24', '60x18', '100x20']],
  ['workflow-recovery-long-question-draft', ['60x18']],
  ['workflow-approval-confirm', ['120x40', '80x24', '60x18', '120x16', '120x14', '120x12']],
  ['workflow-approval-confirm-secret', ['120x40', '80x24', '60x18', '120x16', '120x14', '120x12']],
  ['workflow-recovery-plan-input-too-large', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-recovery-plan-seat', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-recovery-review-model-not-listed', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-seat-switched', ['120x40', '80x24', '60x18', '160x45', '64x20', '56x18']],
  ['workflow-seat-switched-manual', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-spent-b2-replay', ['200x50', '60x18']],
  ['workflow-recovery-fallback-used', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-recovery-apply-conflict', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-recovery-apply-partial-words', ['120x40', '80x24', '60x18', '60x30']],
  ['workflow-recovery-review-contract', ['120x40', '80x24', '60x18', '60x30']],
  ['home-recent-sessions', ['120x40', '80x24']],
  ['workflow-implementation', ['120x40', '80x24', '60x18', '160x45', '220x45']],
  ['workflow-implementation-silent', ['120x40', '80x24', '60x18', '160x45', '220x45']],
  ['workflow-review-check-running', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-review-check-reused', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-implementation-retry', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-implementation-escalated', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-review-fix-narrow-rail', ['22x45', '160x45']],
  ['workflow-task-statuses', ['160x45', '80x24']],
  ['workflow-plan-card', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-plan-card-commenting', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-plan-card-request-empty', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-plan-card-render-note', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-plan-card-shared-command', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-plan-activity', ['120x40', '80x24', '60x18', '160x45', '220x45']],
  ['workflow-output-limit-warning', ['120x40', '160x45']],
  ['workflow-question', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-question-default', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-question-input', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-question-overflow', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-stop-menu-ended-rewound-gate', ['120x40', '80x24', '60x18', '60x40']],
  ['workflow-stop-sheet-fix-inserted', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-stop-sheet', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-stop-sheet-short', ['80x15', '80x14', '80x12', '80x10', '60x12', '40x12']],
  ['workflow-approval-confirm-short', ['80x11', '80x10', '80x9', '80x8', '60x10']],
  ['workflow-plan-card-short', ['80x12', '80x10', '80x9', '80x8', '60x10']],
  ['workflow-question-short', ['80x13', '80x11', '80x10', '60x12']],
  ['workflow-planner-question-short', ['80x12', '80x10', '80x9']],
  ['workflow-recovery-short', ['80x16', '80x14', '80x12', '80x11', '80x9', '80x8', '60x12']],
  ['workflow-ready-planner-accept-short', ['80x14', '80x12', '80x10', '60x12']],
  ['workflow-stop-menu-pause', ['120x40', '80x24', '60x18', '160x45']],
  ['workflow-run-lock-not-released', ['120x40', '80x24', '60x18', '140x40']],
]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('visual catalog', () => {
  it('joins wrapped card text without intervening tool names', () => {
    const frame = twoColumnFrame(
      [' Claude Code CLI ', ' OpenCode CLI '],
      [' The review seat ', ' runs the planner '],
    );
    const card = rightCardText(frame);
    expect(plainFrame(frame)).not.toContain('The review seat runs the planner');
    expect(card).toContain('The review seat runs the planner');
    expect(card).not.toContain('Claude Code CLI');
    expect(card).not.toContain('OpenCode CLI');
  });

  it('does not satisfy a card assertion with text from the Tools column', () => {
    const columns = twoColumnFrame(
      [' Install the tested OpenAI Codex CLI version '],
      [' Unavailable '],
    );
    const frame = `${columns}\nstale models retained`;
    expect(plainFrame(frame)).toContain('Install the tested OpenAI Codex CLI version');
    expect(rightCardText(frame)).not.toContain('Install the tested OpenAI Codex CLI version');
    expect(rightCardText(frame)).toContain('Unavailable');
    expect(plainFrame(frame)).toContain('stale models retained');
  });

  it('rejects unrelated oversized content in the streamed projection', () => {
    const oversized = `unrelated ${'x'.repeat(WORKFLOW_FIXTURE_BOUNDS.maxStringLength)}`;
    expect(() =>
      assertProjectionBounds({
        scenarioId: scenarioId('workflow-implementation-streamed-targets'),
        feature: oversized,
        events: [],
        inputMode: 'normal',
        sidebarVisible: false,
      }),
    ).toThrow('workflow-implementation-streamed-targets exceeds the string bound');
  });

  it('does not exempt streamed payloads in other projections', () => {
    const absolute = resolve(VISUAL_FIXTURE_PROJECT_DIR, 'src/engine/calls/activity-memory.ts');
    const relativeTarget = relative(VISUAL_FIXTURE_PROJECT_DIR, absolute);
    const payload = JSON.stringify({ file_path: absolute });
    const absoluteEscaped = JSON.stringify(absolute).slice(1, -1);
    const relativeEscaped = JSON.stringify(relativeTarget).slice(1, -1);
    const normalizedPayload = payload.split(absoluteEscaped).join(relativeEscaped);
    const bound = WORKFLOW_FIXTURE_BOUNDS.maxStringLength;
    const filler =
      payload.length > bound && normalizedPayload.length <= bound
        ? ''
        : 'x'.repeat(Math.max(0, bound - normalizedPayload.length));
    const value = `${payload}${filler}`;
    expect(value.length).toBeGreaterThan(bound);
    expect(normalizedPayload.length + filler.length).toBeLessThanOrEqual(bound);
    expect(() =>
      assertProjectionBounds({
        scenarioId: scenarioId('workflow-planning'),
        feature: value,
        events: [],
        inputMode: 'normal',
        sidebarVisible: false,
      }),
    ).toThrow('workflow-planning exceeds the string bound');
  });

  it('shows a catalog model with the same name in the Settings crew and fallback rows', async () => {
    const scenario = findVisualScenario('overlay-settings-fallback-catalog');
    const checkpoint = scenario?.checkpoints[0];
    const viewport = scenario?.viewports.find((size) => size.cols === 120);
    if (!scenario || !checkpoint || !viewport) throw new Error('Missing catalog fallback scenario');
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
    try {
      const frame = stripAnsiStyles(await handle.waitForCheckpoint());
      expect(frame).toContain('Crew');
      expect(frame).toContain('Fallback');
      expect(frame.match(/OpenAI Codex CLI · GPT-6-Luna/g)?.length).toBeGreaterThanOrEqual(2);
      expect(frame).not.toContain('GPT-6 Luna');
    } finally {
      await handle.unmount();
    }
  });

  it.each([
    ['overlay-picker-version-timeout-signed-out', 'Auth required', 'Sign in to OpenAI Codex CLI'],
    ['overlay-picker-version-timeout-signed-in', 'Unverified', 'Verify OpenAI Codex CLI against'],
  ])('names the next step after a slow version probe in %s', async (id, state, step) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    if (!scenario || !checkpoint) throw new Error('Missing version timeout scenario');
    for (const viewport of REQUIRED_VIEWPORTS) {
      const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
      try {
        const frame = stripAnsiStyles(await handle.waitForCheckpoint());
        const card = rightCardText(frame);
        expect(card).toContain(state);
        expect(card).toContain(step);
        expect(card).toContain('Its models show here when it is ready.');
        expect(card).toContain('Saved choice:');
        expect(frame).not.toContain('does not support model listing');
        expect(frame).not.toContain('Model detection timed out');
        expect(frame).not.toContain('Bundled model list');
      } finally {
        await handle.unmount();
      }
    }
  });

  it.each([
    ['overlay-picker-older-tool', 'Incompatible', 'Install the tested OpenAI Codex CLI version'],
    [
      'overlay-picker-older-tool-stale',
      'Incompatible',
      'Install the tested OpenAI Codex CLI version',
    ],
    ['overlay-picker-unread-version', 'Unverified', 'Verify OpenAI Codex CLI against'],
    [
      'overlay-picker-signed-out-stale',
      'Auth required',
      'Sign in to OpenAI Codex CLI, then ctrl+r.',
    ],
  ])('names the status and the remedy in %s', async (id, state, remedy) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    if (!scenario || !checkpoint) throw new Error('Missing readiness scenario');
    for (const viewport of REQUIRED_VIEWPORTS) {
      const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
      try {
        const frame = stripAnsiStyles(await handle.waitForCheckpoint());
        const card = rightCardText(frame);
        expect(card).toContain(state);
        expect(card).toContain(remedy);
        expect(card).toContain('Its models show here when it is ready.');
        expect(card).toContain('Saved choice:');
        expect(frame).not.toContain('does not support model listing');
        expect(frame).not.toContain('Bundled model list');
        expect(frame).not.toContain('Models from an earlier check');
        expect(frame).not.toContain('stale models retained');
        expect(frame).not.toContain('7 stale models retained');
        expect(frame).not.toContain('Model detection timed out');
      } finally {
        await handle.unmount();
      }
    }
  });

  it.each([
    {
      id: 'overlay-picker-tool-not-installed',
      title: 'Unavailable',
      remedy: 'Install Cursor Agent CLI, then ctrl+r.',
    },
    {
      id: 'overlay-picker-tool-unverified',
      title: 'Unverified',
      remedy: 'Verify Kilo Code CLI against tested version',
    },
    {
      id: 'overlay-picker-tool-unverified-auth',
      title: 'Unverified',
      remedy: 'authentication cannot be verified without spending a call',
      remedyFillsNarrowCard: true,
    },
    {
      id: 'overlay-picker-tool-incompatible',
      title: 'Incompatible',
      remedy: 'Install the tested OpenAI Codex CLI version',
    },
    {
      id: 'overlay-picker-tool-untrusted',
      title: 'Untrusted',
      remedy: 'Install OpenCode CLI outside the project',
    },
    {
      id: 'overlay-picker-tool-disabled',
      title: 'Disabled',
      remedy: 'Enable Command Code CLI before selecting it',
    },
  ])('shows the $title card for $id', async ({ id, title, remedy, remedyFillsNarrowCard }) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    if (!scenario || !checkpoint) throw new Error(`Missing readiness card ${id}`);
    for (const viewport of REQUIRED_VIEWPORTS) {
      const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
      try {
        const frame = stripAnsiStyles(await handle.waitForCheckpoint());
        const card = rightCardText(frame);
        expect(card).toContain(title);
        expect(card).toContain(remedy);
        if (!remedyFillsNarrowCard || viewport.cols > 60) {
          expect(card).toContain('Its models show here when it is ready.');
        }
        expect(frame).toContain('↑↓ select · esc cancel · ctrl+r refresh');
        expect(frame).not.toContain('⏎');
        expect(frame).not.toContain('Models');
        expect(frame).not.toContain('Add custom model');
        expect(frame).not.toContain('Saved choice:');
        expect(frame).not.toContain('Bundled model list');
        expect(frame).not.toContain('Models from an earlier check');
      } finally {
        await handle.unmount();
      }
    }
  });

  it.each(REQUIRED_VIEWPORTS)(
    'shows the untrusted-tool card without route rows at $cols x $rows',
    async (viewport) => {
      const scenario = findVisualScenario('overlay-picker-routes-unchecked');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing routes-unchecked scenario');
      const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
      try {
        const frame = stripAnsiStyles(await handle.waitForCheckpoint());
        const card = rightCardText(frame);
        expect(card).toContain('Untrusted');
        expect(card).toContain('Install OpenCode CLI outside the project');
        expect(card).toContain('Its models show here when it is ready.');
        expect(card).toContain('Saved choice:');
        expect(frame).not.toContain('opencode-go');
        expect(frame).not.toContain('needs sign-in');
        expect(frame).toContain('↑↓ select · esc cancel · ctrl+r refresh');
        expect(frame).not.toContain('⏎');
      } finally {
        await handle.unmount();
      }
    },
  );

  it('keeps the whole remedy on the unverified-auth card at 60x18', async () => {
    const scenario = findVisualScenario('overlay-picker-tool-unverified-auth');
    const checkpoint = scenario?.checkpoints[0];
    if (!scenario || !checkpoint) throw new Error('Missing unverified-auth scenario');
    const handle = await mountGalleryScenario({
      scenario,
      checkpoint,
      viewport: viewport({ cols: 60, rows: 18 }),
    });
    try {
      const card = rightCardText(stripAnsiStyles(await handle.waitForCheckpoint()));
      expect(card).toContain('settles it');
    } finally {
      await handle.unmount();
    }
  });

  it('ends the cut routes-unchecked card with an ellipsis at 60x18', async () => {
    const scenario = findVisualScenario('overlay-picker-routes-unchecked');
    const checkpoint = scenario?.checkpoints[0];
    if (!scenario || !checkpoint) throw new Error('Missing routes-unchecked scenario');
    const handle = await mountGalleryScenario({
      scenario,
      checkpoint,
      viewport: viewport({ cols: 60, rows: 18 }),
    });
    try {
      const rows = rightCardRows(stripAnsiStyles(await handle.waitForCheckpoint()))
        .map((row) => row.trim())
        .filter((row) => row !== '');
      expect(rows.at(-1)).toMatch(/…$/);
    } finally {
      await handle.unmount();
    }
  });

  it.each(REQUIRED_VIEWPORTS)(
    'keeps the ready tool models and the stale footer at $cols x $rows',
    async (viewport) => {
      const scenario = findVisualScenario('overlay-picker-ready-stale');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing ready-stale scenario');
      const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
      try {
        const frame = stripAnsiStyles(await handle.waitForCheckpoint());
        const plain = plainFrame(frame);
        expect(plain).toContain('GPT-6-Astra');
        expect(plain).toContain('GPT-6-Sol');
        expect(plain).toContain('stale models retained');
        expect(plain).toContain('Models');
        expect(plain).not.toContain('Its models show here when it is ready.');
      } finally {
        await handle.unmount();
      }
    },
  );

  it.each([
    ['overlay-planner-picker-antigravity', 'medium'],
    ['overlay-planner-picker-antigravity-listed', 'high'],
    ['overlay-planner-picker-antigravity-low', 'low'],
    ['overlay-settings-antigravity-low', 'low'],
  ])('shows the saved Antigravity level in %s', async (id, level) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    const viewport = scenario?.viewports.find((size) => size.cols === 120);
    if (!scenario || !checkpoint || !viewport) throw new Error('Missing Antigravity scenario');
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
    try {
      const frame = stripAnsiStyles(await handle.waitForCheckpoint());
      expect(configStore.get().config?.planner).toMatchObject({
        model: `gemini-3.8-flash-${level}`,
      });
      expect(configStore.get().config?.planner).not.toHaveProperty('effort');
      if (id.startsWith('overlay-planner-picker')) {
        expect(frame).toContain(`gemini-3.8-flash-${level} · ${level}`);
        expect(frame).toContain('Claude Opus 5.5');
        expect(frame).toContain('Claude Sonnet 5.5');
        expect(frame).not.toContain('Gemini 3.7');
      } else {
        expect(frame).toContain(`Google Antigravity CLI · Gemini 3.8 Flash · ${level}`);
      }
    } finally {
      await handle.unmount();
    }
  });

  it('lists idle and filtered tools in one order without group rows', async () => {
    const localNames = ['llama.cpp', 'LM Studio'].toSorted((left, right) =>
      left.localeCompare(right),
    );
    const idleNames = [
      '+ Add custom command…',
      'OpenAI Codex CLI',
      'Claude Code CLI',
      'Kilo Code CLI',
      'Command Code CLI',
      'Cursor Agent CLI',
      'Google Antigravity CLI',
      'OpenCode CLI',
      'Ollama',
      ...localNames,
    ];
    const filteredNames = [
      'OpenAI Codex CLI',
      'Claude Code CLI',
      'Kilo Code CLI',
      'Command Code CLI',
      'OpenCode CLI',
      '+ Add custom command…',
    ];
    for (const [id, names] of [
      ['overlay-picker-tool-order', idleNames],
      ['overlay-picker-tool-order-filter', filteredNames],
    ] as const) {
      const scenario = findVisualScenario(id);
      const checkpoint = scenario?.checkpoints[0];
      const size = scenario?.viewports.find((item) => item.cols === 120);
      if (!scenario || !checkpoint || !size) throw new Error(`Missing ${id}`);
      const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: size });
      try {
        const frame = stripAnsiStyles(await handle.waitForCheckpoint());
        expectConsecutiveToolRows(frame, names);
        expect(frame).not.toContain('Local connections');
        expect(frame).not.toContain('CLI tools');
        if (id === 'overlay-picker-tool-order-filter') {
          expect(frame).not.toContain('Cursor Agent CLI');
          expect(frame).not.toContain('Google Antigravity CLI');
          expect(frame).not.toContain('llama.cpp');
          expect(frame).not.toContain('LM Studio');
        }
      } finally {
        await handle.unmount();
      }
    }
  });

  it('registers the historical smoke replay and expanded recovery checkpoints', () => {
    const replay = findVisualScenario('workflow-spent-b2-replay');
    expect(replay?.viewports.map(formatViewport)).toEqual(['200x50', '60x18']);
    expect(replay?.checkpoints[0]).toMatchObject({ id: 'spent-b2-replay', kind: 'implementation' });
    expect(workflowFixtureRegistry.has(scenarioId('workflow-spent-b2-replay'))).toBe(true);
    expect(workflowCheckpointPredicates.has(checkpointId('spent-b2-replay'))).toBe(true);
    expect(replay?.checkpoints.map((checkpoint) => checkpoint.id)).toEqual([
      'spent-b2-replay',
      'spent-b2-replay-t001-activity',
      'spent-b2-replay-t001-completion',
      'spent-b2-replay-t002-activity',
      'spent-b2-replay-t002-completion',
    ]);
    const switched = findVisualScenario('workflow-seat-switched');
    expect(switched?.checkpoints.map((checkpoint) => checkpoint.id)).toEqual([
      'seat-switched',
      'seat-switched-expanded-recovery',
    ]);
    expect(workflowCheckpointPredicates.has(checkpointId('seat-switched-expanded-recovery'))).toBe(
      true,
    );
  });

  it.each([
    [
      'spent-b2-replay-t001-activity',
      ['BUILD activity  5 updates', '+2 more · ctrl+a', 'Edit    test/text.test.js'],
    ],
    ['spent-b2-replay-t001-completion', ['src/text.js · test/text.test.js']],
    [
      'spent-b2-replay-t002-activity',
      ['BUILD activity  4 updates', '+1 more · ctrl+a', 'Edit    test/preview.test.js'],
    ],
    ['spent-b2-replay-t002-completion', ['src/preview.js · test/preview.test.js']],
  ])('captures visible replay rows at 60x18 for %s', async (id, markers) => {
    const scenario = findVisualScenario('workflow-spent-b2-replay');
    const checkpoint = scenario?.checkpoints.find((value) => value.id === id);
    const narrow = scenario?.viewports.find((value) => value.cols === 60 && value.rows === 18);
    if (!scenario || !checkpoint || !narrow) throw new Error(`Missing replay checkpoint ${id}`);
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: narrow });
    try {
      const frame = stripAnsiStyles(await handle.waitForCheckpoint());
      for (const marker of markers) expect(frame).toContain(marker);
      const predicate = workflowCheckpointPredicates.get(checkpoint.id);
      expect(predicate?.({ scenario, checkpoint, viewport: narrow, output: '' })).toBe(false);
    } finally {
      await handle.unmount();
    }
  });

  it.each([
    ['workflow-recovery-no-fallback', 'Change BUILD tool'],
    ['workflow-recovery-fallback-used', 'Change BUILD tool'],
    ['workflow-recovery-fallback-not-installed', 'Change BUILD tool'],
    ['workflow-seat-switched', 'BUILD  OpenCode CLI'],
    ['workflow-seat-switched-manual', 'BUILD  OpenCode CLI'],
  ])('registers %s at every required viewport', (id, marker) => {
    const scenario = findVisualScenario(id);
    expect(scenario, id).toBeDefined();
    expect(scenario?.viewports).toEqual(
      id === 'workflow-recovery-no-fallback' || id === 'workflow-recovery-fallback-not-installed'
        ? REQUIRED_VIEWPORTS
        : id === 'workflow-seat-switched'
          ? [...WIDE_VIEWPORTS, viewport({ cols: 64, rows: 20 }), viewport({ cols: 56, rows: 18 })]
          : WIDE_VIEWPORTS,
    );
    expect(scenario?.checkpoints[0]?.marker).toBe(marker);
  });

  it.each([
    ['workflow-review-task-cadence', 'Review T002'],
    ['workflow-review-task-cadence-settled', 'Final review after 1 fix cycle passed'],
    ['workflow-review-task-out-of-scope', 'Review T001 passed'],
  ])('registers %s with its review checkpoint and sidebar viewport', (id, marker) => {
    const scenario = findVisualScenario(id);
    expect(scenario?.checkpoints[0]?.marker).toBe(marker);
    expect(scenario?.viewports.map(formatViewport)).toEqual(['120x40', '80x24', '60x18', '160x45']);
    expect(scenario?.elements.map((element) => element.id)).toContain('sidebar');
    expect(workflowFixtureRegistry.has(scenarioId(id))).toBe(true);
  });

  it('covers Form C with inserted fixes and status words with a sidebar', () => {
    const narrow = findVisualScenario('workflow-review-fix-narrow-rail');
    expect(narrow?.checkpoints[0]?.marker).toBe('4/7 briefs passed');
    expect(narrow?.viewports.map(formatViewport)).toEqual(['22x45', '160x45']);
    expect(narrow?.checkpoints.map((checkpoint) => checkpoint.id)).toEqual([
      'review-fix-narrow-rail',
      'review-fix-narrow-rail-stop',
    ]);
    expect(selectRailForm({ phase: 'implementing', cols: 22 })).toBe('C');
    const statuses = findVisualScenario('workflow-task-statuses');
    expect(statuses?.viewports.map(formatViewport)).toEqual(['160x45', '80x24']);
  });

  it('covers the running inserted fix pause copy and the sidebar above 120 columns', () => {
    const scenario = findVisualScenario('workflow-stop-sheet-fix-inserted');
    expect(scenario?.checkpoints[0]?.marker).toBe('finish T006');
    expect(scenario?.viewports.map(formatViewport)).toEqual(['120x40', '80x24', '60x18', '160x45']);
  });

  it.each([
    ['workflow-continuous-transcript', 'continuous-transcript', 'implementation'],
    ['workflow-continuous-transcript-ready', 'continuous-transcript-ready', 'success'],
  ])('covers %s with a registered transcript checkpoint', (id, checkpoint, kind) => {
    const scenario = findVisualScenario(id);
    expect(scenario?.checkpoints[0]).toMatchObject({ id: checkpoint, kind });
    expect(scenario?.viewports).toEqual([...WIDE_VIEWPORTS, viewport({ cols: 200, rows: 50 })]);
    expect(scenario?.elements.map((element) => element.id)).toEqual([
      'header',
      'transcript',
      'sidebar',
    ]);
    expect(workflowFixtureRegistry.has(scenarioId(id))).toBe(true);
    expect(workflowCheckpointPredicates.has(checkpointId(checkpoint))).toBe(true);
  });

  it.each([
    'workflow-implementation-narration',
    'workflow-implementation-adjacent-narration',
    'workflow-implementation-fenced-handback',
  ])('rejects raw file-link markdown in the %s checkpoint', (id) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    const viewport = scenario?.viewports[0];
    const predicate = checkpoint && workflowCheckpointPredicates.get(checkpoint.id);
    if (!scenario || !checkpoint || !viewport || !predicate)
      throw new Error(`Missing narration checkpoint ${id}`);
    expect(
      predicate({
        scenario,
        checkpoint,
        viewport,
        output: `${checkpoint.marker}\nbriefs passed\n[src/row.ts](file:///tmp/src/row.ts)`,
      }),
    ).toBe(false);
  });

  it('keeps the recovery stop-sheet predicate separate from generic ready checkpoints', () => {
    const scenario = findVisualScenario('workflow-stop-sheet-recovery');

    expect(scenario?.checkpoints.map((checkpoint) => checkpoint.id)).toEqual([
      'stop-sheet-recovery',
    ]);
    expect(workflowCheckpointPredicates.has(checkpointId('stop-sheet-recovery'))).toBe(true);
    expect(workflowCheckpointPredicates.has(checkpointId('ready'))).toBe(false);
  });

  it('rejects recovery stop-sheet frames that offer pause or typed correction', () => {
    const scenario = findVisualScenario('workflow-stop-sheet-recovery');
    const checkpoint = scenario?.checkpoints[0];
    const viewport = scenario?.viewports[0];
    const predicate = workflowCheckpointPredicates.get(checkpointId('stop-sheet-recovery'));
    if (
      scenario === undefined ||
      checkpoint === undefined ||
      viewport === undefined ||
      predicate === undefined
    ) {
      throw new Error('Missing recovery stop-sheet checkpoint');
    }
    const context = { scenario, checkpoint, viewport, output: 'Stop options\nStop now\nEnd run' };

    expect(predicate(context)).toBe(true);
    for (const stale of ['Pause after this brief', 'tab to type a correction']) {
      expect(predicate({ ...context, output: `${context.output}\n${stale}` })).toBe(false);
    }
  });

  it('requires the balance headline before capturing a spent-balance frame', () => {
    const scenario = findVisualScenario('workflow-recovery-balance-spent');

    expect(scenario?.checkpoints[0]?.marker).toBe(
      'Seat down · Balance spent on deepseek (OpenCode CLI)',
    );
  });

  it('covers an automatic balance switch and its sidebar at a wide viewport', () => {
    const scenario = findVisualScenario('workflow-seat-switched-balance');

    expect(scenario?.checkpoints[0]?.marker).toBe('BUILD  OpenCode CLI');
    expect(scenario?.viewports.map(formatViewport)).toEqual(['120x40', '80x24', '60x18', '160x45']);
    expect(scenario?.elements.map((element) => element.id)).toContain('sidebar');
  });

  it('keeps the interrupted fix row stopped while the continued brief runs', async () => {
    const scenario = findVisualScenario('workflow-fix-check-stopped-continued');
    if (scenario === undefined) throw new Error('Missing stopped-check scenario');
    const checkpoint = scenario.checkpoints[0];
    const viewport = scenario.viewports.find((size) => size.cols === 80);
    if (checkpoint === undefined || viewport === undefined) throw new Error('Missing checkpoint');
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
    try {
      const frame = stripAnsiStyles(await handle.waitForCheckpoint());
      expect(frame).toContain('Fix check V2 · npm test · stopped');
      expect(frame).toContain('working on T904');
      expect(frame).toContain('Stopped at T904');
      expect(frame).not.toContain('Stopped mid-turn');
      expect(frame).not.toContain('Fix check V2 · npm test · running');
      expect(frame).not.toContain('running 0:40');
    } finally {
      await handle.unmount();
    }
  });
  it.each([80, 120])(
    'shows render collection and its twelve-second clock at %s columns',
    async (cols) => {
      const scenario = findVisualScenario('workflow-review-render-running');
      if (scenario === undefined) throw new Error('Missing render scenario');
      const checkpoint = scenario.checkpoints[0];
      const viewport = scenario.viewports.find((size) => size.cols === cols);
      if (checkpoint === undefined || viewport === undefined) throw new Error('Missing checkpoint');
      const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
      try {
        const frame = stripAnsiStyles(await handle.waitForCheckpoint());
        expect(frame).toContain('3/3 briefs passed');
        expect(frame).toContain('Review · Render workflow-review');
        expect(frame).toContain('running 0:12');
        expect(frame).toContain('Review · Render workflow-review 0:12');
        const plain = workflowTranscriptText();
        for (const id of ['T901', 'T902', 'T903']) expect(plain).toContain(`● ${id}`);
        expect(plain).toMatch(/● T902[^\n]*registry\.ts/);
        expect(plain).toMatch(/● T903[^\n]*review-fixture\.md/);
        expect(frame).toContain('Render workflow-plan-compiled · rendered · 14.2s');
        expect(frame).toContain('Render workflow-implementation · failed · 11.0s');
        expect(frame).toContain('Render workflow-review · running');
        expect(frame).not.toContain('npm run tui-shots');
      } finally {
        await handle.unmount();
      }
    },
  );
  it.each([80, 120])('names the consult brief in build progress at %s columns', async (cols) => {
    const scenario = findVisualScenario('workflow-build-consult');
    if (scenario === undefined) throw new Error('Missing consult scenario');
    const checkpoint = scenario.checkpoints[0];
    const viewport = scenario.viewports.find((size) => size.cols === cols);
    if (checkpoint === undefined || viewport === undefined) throw new Error('Missing checkpoint');
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
    try {
      const frame = stripAnsiStyles(await handle.waitForCheckpoint());
      expect(frame).toContain(
        'PLAN · Claude Code CLI · Claude Sonnet 4 · answering the consult on T901',
      );
    } finally {
      await handle.unmount();
    }
  });

  it.each([80, 120])('names the plan seat on a fix-task consult at %s columns', async (cols) => {
    const scenario = findVisualScenario('workflow-build-fix-consult');
    if (scenario === undefined) throw new Error('Missing fix consult scenario');
    const checkpoint = scenario.checkpoints[0];
    const viewport = scenario.viewports.find((size) => size.cols === cols);
    if (checkpoint === undefined || viewport === undefined) throw new Error('Missing checkpoint');
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
    try {
      const frame = stripAnsiStyles(await handle.waitForCheckpoint());
      expect(frame).toContain(
        'PLAN · Claude Code CLI · Claude Sonnet 4 · answering the consult on T904',
      );
      expect(frame).toContain('PLAN → T904: guidance');
    } finally {
      await handle.unmount();
    }
  });

  it.each([80, 120])('keeps fix-check phrases whole at %s columns', async (cols) => {
    const scenario = findVisualScenario('workflow-fix-check-done');
    if (scenario === undefined) throw new Error('Missing fix-check scenario');
    const checkpoint = scenario.checkpoints[0];
    const viewport = scenario.viewports.find((size) => size.cols === cols);
    if (checkpoint === undefined || viewport === undefined) throw new Error('Missing checkpoint');
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
    try {
      const frame = stripAnsiStyles(await handle.waitForCheckpoint());
      for (const phrase of [
        '1 of your 2 failures remains',
        '1 left to T905',
        '1 of your 2 failures gone',
        '2 others left for their fix tasks or the next review',
      ]) {
        expect(frame).toContain(phrase.replaceAll(' ', '\u00a0'));
      }
    } finally {
      await handle.unmount();
    }
  });

  it('leaves the shared failure to a fix brief of the same review and re-runs the command of the red', async () => {
    const scenario = findVisualScenario('workflow-fix-check-done');
    const checkpoint = scenario?.checkpoints[0];
    const viewport = scenario?.viewports.find((size) => size.cols === 120);
    if (scenario === undefined || checkpoint === undefined || viewport === undefined) {
      throw new Error('Missing fix-check scenario');
    }
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
    try {
      const frame = stripAnsiStyles(await handle.waitForCheckpoint());
      expect(frame).toContain('Reviewer check V2 · npm test · 1\u00a0new, 0\u00a0pre-existing');
      expect(frame).toContain('fixes T904 T905');
      expect(frame.match(/Fix check V2 · npm test · /g)).toHaveLength(2);
      expect(frame).not.toContain('test-ci');
    } finally {
      await handle.unmount();
    }
  });

  it.each([
    ['workflow-review-context-insufficient', true],
    ['workflow-review-call-failed', false],
  ] as const)('renders recovery copy for %s', async (id, needsContext) => {
    const scenario = findVisualScenario(id);
    if (scenario === undefined) throw new Error(`Missing scenario ${id}`);
    const checkpoint = scenario.checkpoints[0];
    const viewport = scenario.viewports.find((size) => size.cols === 120);
    if (checkpoint === undefined || viewport === undefined) throw new Error('Missing checkpoint');
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
    try {
      const frame = stripAnsiStyles(await handle.waitForCheckpoint());
      expect(frame).toContain('Try again');
      expect(frame.includes('/crew review')).toBe(needsContext);
      expect(frame).not.toContain('/resume');
    } finally {
      await handle.unmount();
    }
  });

  it('shows a failed task beside the retried task at a sidebar viewport', async () => {
    const scenario = findVisualScenario('workflow-implementation-retry');
    if (scenario === undefined) throw new Error('Missing retry scenario');
    const checkpoint = scenario.checkpoints[0];
    const wide = scenario.viewports.find((size) => size.cols > 120);
    if (checkpoint === undefined || wide === undefined) throw new Error('Missing wide checkpoint');
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: wide });
    try {
      const frame = stripAnsiStyles(await handle.waitForCheckpoint());
      expect(frame).toContain('attempt 7');
      expect(frame.split('\n').some((row) => /Register.*failed/.test(row))).toBe(true);
    } finally {
      await handle.unmount();
    }
  });

  it('marks planning stopped in the sidebar beside a plan-seat halt', async () => {
    const scenario = findVisualScenario('workflow-recovery-plan-seat');
    if (scenario === undefined) throw new Error('Missing plan-seat scenario');
    const checkpoint = scenario.checkpoints[0];
    const wide = scenario.viewports.find((size) => size.cols > 120);
    if (checkpoint === undefined || wide === undefined) throw new Error('Missing wide checkpoint');
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: wide });
    try {
      const frame = stripAnsiStyles(await handle.waitForCheckpoint());
      expect(frame).toContain('Planning stopped');
    } finally {
      await handle.unmount();
    }
  });

  it('retains fixtures for the changed composer, preparation, usage and local-server surfaces', () => {
    for (const id of [
      'home-preparing',
      'home-preparation-failed',
      'home-preparation-blocked',
      'home-preparation-isolation-blocked',
      'workflow-continuing',
      'home-draft-image',
      'home-draft-outside-image',
      'home-attachment-not-found',
      'home-attachment-not-a-file',
      'home-attachment-too-large',
      'home-attachment-unreadable',
      'home-attachment-not-text',
      'workflow-start-attached-files',
      'workflow-composer-outside-file',
      'workflow-question-outside-file',
      'home-draft-path',
      'workflow-planning-path-notice',
      'workflow-start-readiness-warning',
      'overlay-usage-details',
      'overlay-usage-details-legacy',
      'overlay-usage-details-unpriced',
      'overlay-usage-context-insufficient',
      'overlay-local-connection-ollama',
      'overlay-local-connection-lmstudio',
      'overlay-local-connection-llamacpp',
      'overlay-picker-auth-config-owned',
      'overlay-picker-auth-unsupported',
    ]) {
      expect(findVisualScenario(id), id).toBeDefined();
    }
  });

  it.each([
    {
      reason: 'not-found',
      path: '/Users/me/notes/product-planning/archive/receiving-workflow/brief.md',
      prompt: 'use this brief',
    },
    {
      reason: 'not-a-file',
      path: '/Users/me/notes/product-planning/archive/',
      prompt: 'use this folder',
    },
    {
      reason: 'too-large',
      path: '/Users/me/exports/receiving-dump.log',
      prompt: 'summarize this',
    },
    {
      reason: 'unreadable',
      path: '/Users/me/notes/product-planning/archive/receiving-workflow/brief.md',
      prompt: 'use this brief',
    },
    {
      reason: 'not-text',
      path: '/Users/me/exports/archive.zip',
      prompt: 'read this archive',
    },
  ] satisfies { reason: InputFileFailureReason; path: string; prompt: string }[])(
    'renders a retained draft that matches the $reason refusal',
    async ({ reason, path, prompt }) => {
      const scenario = findVisualScenario(`home-attachment-${reason}`);
      const checkpoint = scenario?.checkpoints[0];
      if (scenario === undefined || checkpoint === undefined) {
        throw new Error(`Missing attachment fixture: ${reason}`);
      }
      const feedback = formatAttachmentFailure({ action: 'send', reason, path });
      for (const viewport of REQUIRED_VIEWPORTS) {
        const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
        try {
          const frame = await handle.waitForCheckpoint();
          expect(composerLiveStore.get().text).toBe(`@${path} ${prompt}`);
          expect(feedbackStore.get()).toEqual({ message: feedback, isError: true });
          const plain = stripTerminalControls(frame).replace(/\s+/g, ' ');
          expect(plain).toContain(feedback.slice(0, feedback.indexOf('. ')));
          if (viewport.cols === 120) expect(plain).toContain(feedback);
        } finally {
          await handle.unmount();
        }
      }
    },
  );

  it.each([
    ['offline', 'Ollama is not reachable'],
    ['timeout', 'Ollama did not answer'],
    ['unauthorized', 'LM Studio rejected the token'],
    ['empty', 'no models installed'],
    ['missing', 'not in this catalog'],
    ['loaded', 'loaded'],
    ['not-loaded', 'not loaded'],
    ['listed', 'listed'],
  ])('renders the %s server outcome through the mounted connection check', async (state, text) => {
    const scenario = findVisualScenario(`overlay-local-connection-${state}`);
    if (scenario === undefined) throw new Error(`Missing local fixture: ${state}`);
    const checkpoint = scenario.checkpoints[0];
    if (checkpoint === undefined) throw new Error('Missing checkpoint');
    for (const viewport of REQUIRED_VIEWPORTS) {
      const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
      try {
        const frame = stripAnsiStyles(await handle.waitForCheckpoint());
        expect(frame).toContain(text);
        expect(frame).toContain('retry');
        if (state !== 'unauthorized') expect(frame).not.toContain('rejected the token');
      } finally {
        await handle.unmount();
      }
    }
  });
  it('covers the exact router screen and overlay unions with unique versioned scenarios', () => {
    const screens = VISUAL_CATALOG.flatMap((scenario) =>
      scenario.surface.kind === 'screen' ? [scenario.surface.screen] : [],
    );
    const overlays = VISUAL_CATALOG.flatMap((scenario) =>
      scenario.surface.kind === 'overlay' ? [scenario.surface.overlay] : [],
    );
    const scenarioIds = VISUAL_CATALOG.map((scenario) => scenario.id);
    const duplicateIds = scenarioIds.filter((id, index) => scenarioIds.indexOf(id) !== index);

    expect(sorted(new Set(screens))).toEqual(sorted(ALL_SCREENS));
    expect(sorted(new Set(overlays))).toEqual(sorted(ACTIVE_OVERLAYS));
    expect(duplicateIds).toEqual([]);
    expect(VISUAL_CATALOG_VERSION).toBe(1);
    expect(
      VISUAL_CATALOG.every(
        (scenario) =>
          scenario.fixtureVersion === VISUAL_FIXTURE_VERSION &&
          scenario.title.length > 0 &&
          scenario.checkpoints.length > 0,
      ),
    ).toBe(true);
  });

  it('contains the required viewport matrix, workflow checkpoints, and named crops', () => {
    const checkpointIds = new Set<string>(
      VISUAL_CATALOG.flatMap((scenario) => scenario.checkpoints.map((checkpoint) => checkpoint.id)),
    );
    const checkpointKinds = new Set(
      VISUAL_CATALOG.flatMap((scenario) =>
        scenario.checkpoints.map((checkpoint) => checkpoint.kind),
      ),
    );

    expect(REQUIRED_VIEWPORTS.map(formatViewport)).toEqual(['120x40', '80x24', '60x18']);
    expect(REQUIRED_WORKFLOW_CHECKPOINT_IDS.every((id) => checkpointIds.has(id))).toBe(true);
    expect(REQUIRED_WORKFLOW_CHECKPOINT_KINDS.every((kind) => checkpointKinds.has(kind))).toBe(
      true,
    );
    expect(VISUAL_CATALOG.every((scenario) => scenario.elements.length > 0)).toBe(true);
  });

  it('keeps every scenario on the required viewport matrix except where the catalog says so', () => {
    for (const scenario of VISUAL_CATALOG) {
      expect(scenario.viewports.map(formatViewport)).toEqual(
        SCENARIO_VIEWPORT_EXCEPTIONS.get(scenario.id) ?? REQUIRED_VIEWPORTS.map(formatViewport),
      );
    }
  });

  it('pairs every scenario with a fixture and leaves no fixture unreferenced', () => {
    const registered = [
      ...workflowFixtureRegistry.keys(),
      ...screenFixtureRegistry.keys(),
      ...overlayFixtureRegistry.keys(),
      ...editorHandoverScenarios.keys(),
    ];

    expect(new Set(registered).size).toBe(registered.length);
    expect(sorted(registered)).toEqual(sorted(VISUAL_CATALOG.map((scenario) => scenario.id)));
  });

  it('gives each screen and overlay scenario its own fixture registration', () => {
    const factories = [...screenFixtureRegistry.values(), ...overlayFixtureRegistry.values()];

    expect(new Set(factories).size).toBe(factories.length);
  });

  it('lists the catalog without changing stores or starting network work', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const routeBefore = routerStore.get();
    const configBefore = configStore.get();

    const scenarios = listVisualScenarios();
    expect(scenarios).toEqual(VISUAL_CATALOG);
    expect(routerStore.get()).toBe(routeBefore);
    expect(configStore.get()).toBe(configBefore);
    expect(fetch).not.toHaveBeenCalled();
  });
});
