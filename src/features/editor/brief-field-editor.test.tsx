import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Box } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import { TASKS_FILE } from '../../core/paths.js';
import { readSpecFile, type SpecFileRef } from '../../core/paths-io.js';
import type { Task } from '../../core/schemas/task.js';
import { parseTasksStrict } from '../../engine/spec/parser.js';
import { editorStore } from '../../stores/ui/editor.js';
import { externalEditRequestStore } from '../../stores/ui/external-edit-request.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { briefFieldList, readField } from './brief-field-model.js';
import { BriefFieldEditor } from './brief-field-editor.js';

const CTRL_S = '\x13';
const CTRL_O = '\x0f';
const TAB = '\t';
const LAYOUT = { columns: 40, rows: 6 };
const SESSION_REF = { projectDir: '/tmp', sessionId: 's1' };

function validTask(overrides: Parameters<typeof makeTask>[0] = {}): Task {
  return makeTask({
    id: 'T001',
    title: 'Add greeting helper',
    action: 'create',
    file: 'src/greet.ts',
    description: 'Add a helper that returns a friendly greeting string.',
    signature: 'export function greet(name: string): string',
    pattern: 'follow the existing helper shape',
    tests: ['returns hello for an empty name', 'includes the provided name'],
    constraints: ['pure function', 'no external dependencies'],
    typeDefs: 'export type Greeting = string;',
    implementationSteps: ['define the greet function', 'export it from the module'],
    escalation: ['stop if the greeting format is ambiguous'],
    evidence: ['npm test passes', 'greet added'],
    scope: { inBounds: ['only greet'], outOfBounds: ['do not touch the barrel'] },
    ...overrides,
  });
}

function view() {
  return (
    <BriefFieldEditor
      tasks={[makeTask({ id: 'T001', title: 'Create hello module' })]}
      taskIndex={0}
      sessionRef={SESSION_REF}
      resolve={() => {}}
      height={6}
    />
  );
}

describe('BriefFieldEditor mount ownership', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    editorStore.close();
    reviewStore.clearReview();
  });

  it('renders the field while the session token still owns the live prompt', async () => {
    const token = reviewStore.setReviewFile('/tmp/TASKS.md');
    editorStore.openField({
      filePath: '/tmp/TASKS.md',
      value: 'Create hello module',
      ownerToken: token,
      layout: LAYOUT,
    });

    const ui = renderFeature(view());
    unmount = ui.unmount;
    await tick();
    expect(ui.lastFrame()).toContain('T001');
  });

  it('seeds the buffer from the focused Task when the trigger opens an empty field session', async () => {
    // The trigger opens the field session with an EMPTY value (it has no access to the parsed
    // brief model). BriefFieldEditor must seed the buffer from readField(task, firstField) so the
    // field editor is reachable with real content — not the vestigial task.file path (REQ-036).
    const token = reviewStore.setReviewFile('/tmp/TASKS.md');
    editorStore.openField({ filePath: null, value: '', ownerToken: token, layout: LAYOUT });

    const ui = renderFeature(view());
    unmount = ui.unmount;
    await tick();
    expect(ui.lastFrame()).toContain('Create hello module');
    expect(editorStore.get()).toMatchObject({ status: 'open', value: 'Create hello module' });
  });

  it('renders nothing once the review token advances past the session token', async () => {
    const token = reviewStore.setReviewFile('/tmp/TASKS.md');
    editorStore.openField({
      filePath: '/tmp/TASKS.md',
      value: 'Create hello module',
      ownerToken: token,
      layout: LAYOUT,
    });

    const ui = renderFeature(view());
    unmount = ui.unmount;
    await tick();
    expect(ui.lastFrame()).toContain('T001');

    // The owner disconnects: the RPC dispatcher advances reviewStore.ownerToken. The field
    // session still carries the stale token, so mount (like suppression and the key hook) must
    // collapse to null and release input to the newer live prompt (CON-B / REQ-043).
    reviewStore.setReviewFile('/tmp/TASKS.md');
    await tick();
    expect(ui.lastFrame()).not.toContain('T001');
    // The editor session itself is still open — proving the guard keys on ownership, not raw
    // open-state, so it stays equivalent to the ownerToken-checked write-gate.
    expect(editorStore.get().status).toBe('open');
  });
});

describe('BriefFieldEditor multi-field editing and save gate', () => {
  let unmount: (() => void) | undefined;
  const tempDirs: string[] = [];

  function tempSessionRef(): SpecFileRef {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'diptych-brief-field-')));
    tempDirs.push(dir);
    return { projectDir: dir, sessionId: 's1' };
  }

  function open(task: Task, sessionRef: SpecFileRef, resolved: ApprovalReviewResult[], height = 6) {
    const first = briefFieldList(task)[0] ?? 'title';
    const owner = reviewStore.setReviewFile('spec.md');
    editorStore.openField({
      filePath: 'tasks.md',
      value: readField(task, first),
      ownerToken: owner,
      layout: LAYOUT,
    });
    const ui = renderFeature(
      <BriefFieldEditor
        tasks={[task]}
        taskIndex={0}
        sessionRef={sessionRef}
        resolve={(r) => resolved.push(r)}
        height={height}
      />,
    );
    unmount = ui.unmount;
    return ui;
  }

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    editorStore.close();
    externalEditRequestStore.reset();
    reviewStore.clearReview();
  });

  it('discards the in-progress field edit on Ctrl+O and emits the external-edit intent (REQ-142/150)', async () => {
    // Ctrl+O on the field surface hands off to the external editor as the sole tasks.md writer:
    // the in-memory field edit is thrown away (nothing written from the inline path) and only the
    // neutral intent — carrying the owner token for the consumer-side CAS — is emitted.
    const sessionRef = tempSessionRef();
    const task = validTask();
    const resolved: ApprovalReviewResult[] = [];
    const ui = open(task, sessionRef, resolved);
    await tick(20);

    const owner = reviewStore.get().ownerToken;

    // Mutate the in-progress buffer so a discard is observable.
    ui.stdin.write('Z');
    await tick(20);

    ui.stdin.write(CTRL_O);
    await tick(20);

    // Nothing is written to tasks.md from the inline path, and the gate is not resolved.
    expect(readSpecFile(sessionRef, TASKS_FILE)).toBeNull();
    expect(resolved).toEqual([]);
    expect(editorStore.get().status).toBe('closed');
    expect(externalEditRequestStore.get()).toEqual({ status: 'requested', ownerToken: owner });
  });

  it('accumulates edits from multiple fields into the written tasks.md when Tab moves between them', async () => {
    // REQ-036: editing one field, Tabbing to the next, and editing it too must land BOTH edits in
    // the resolved/written task set — proving the writeField-commit → field-wrap → openField
    // re-seed cycle carries prior fields forward through the shared workingTask.
    const sessionRef = tempSessionRef();
    const task = validTask();
    const resolved: ApprovalReviewResult[] = [];
    const ui = open(task, sessionRef, resolved);
    await tick(20);

    // Field A is the first non-empty field (title). openField seeds the cursor at index 0, so a
    // keystroke prepends a marker onto the seeded value.
    ui.stdin.write('Z');
    await tick(20);

    // Tab commits field A and moves to field B (file); edit it too.
    ui.stdin.write(TAB);
    await tick(20);
    ui.stdin.write('Q');
    await tick(20);

    ui.stdin.write(CTRL_S);
    await tick(20);

    expect(resolved).toEqual([{ approved: false, action: 'edit' }]);
    const written = readSpecFile(sessionRef, TASKS_FILE);
    expect(written).not.toBeNull();
    const parsed = parseTasksStrict(written ?? '');
    expect(parsed[0]?.title).toBe('ZAdd greeting helper');
    expect(parsed[0]?.file).toBe('Qsrc/greet.ts');
  });

  it('keeps its whole surface within the region height so the decision controls stay visible (CON-D)', async () => {
    // A field whose value wraps to far more visual lines than the region can hold (15 lines vs a
    // height-8 region) must NOT paint at FIELD_MAX_ROWS: the viewport is clamped to height − chrome
    // so identity + field + controls together fit inside the region's overflow:hidden box.
    const sessionRef = tempSessionRef();
    const tallTitle = Array.from({ length: 15 }, (_, i) => `row ${i}`).join('\n');
    const task = validTask({ title: tallTitle });
    const ui = open(task, sessionRef, [], 8);
    await tick(20);

    const lines = (ui.lastFrame() ?? '').split('\n');
    expect(lines.length).toBeLessThanOrEqual(8); // without the clamp: 1 + 12 + 1 === 14
    expect(ui.lastFrame()).toContain('ctrl+s save');
  });

  it('rejects a save that fails the brief gate: surfaces the first error, does not write or resolve, keeps the session open', async () => {
    // REQ-037 negative path: when checkBriefSave fails the save is rejected — the first failure
    // message is surfaced, the buffer is kept, and the prior approved state is unchanged (no
    // write, no resolve, session stays open). Vague-only tests trip vague_validation while every
    // other gate (round-trip, scope, evidence, topo) still passes, so the surfaced error is
    // deterministic.
    const sessionRef = tempSessionRef();
    const task = validTask({ tests: ['works'] });
    const resolved: ApprovalReviewResult[] = [];
    const ui = open(task, sessionRef, resolved);
    await tick(20);

    ui.stdin.write(CTRL_S);
    await tick(20);

    expect(ui.lastFrame()).toContain('vague');
    expect(resolved).toEqual([]);
    expect(editorStore.get().status).toBe('open');
    expect(readSpecFile(sessionRef, TASKS_FILE)).toBeNull();
  });
});

describe('BriefFieldEditor footer stays one controls row (F-201)', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    editorStore.close();
    reviewStore.clearReview();
  });

  // The ~70-col controls hint must never soft-wrap: at a narrow inner width it would take two rows,
  // break the FIELD_CHROME_ROWS=3 reservation, and push a field/footer row out of the region's
  // overflow:hidden box. wrap="truncate" keeps it on exactly one terminal row.
  function renderAtWidth(task: Task, width: number, height = 8) {
    const owner = reviewStore.setReviewFile('spec.md');
    const first = briefFieldList(task)[0] ?? 'title';
    editorStore.openField({
      filePath: 'tasks.md',
      value: readField(task, first),
      ownerToken: owner,
      layout: LAYOUT,
    });
    const ui = renderFeature(
      <Box width={width} overflow="hidden">
        <BriefFieldEditor
          tasks={[task]}
          taskIndex={0}
          sessionRef={SESSION_REF}
          resolve={() => {}}
          height={height}
        />
      </Box>,
    );
    unmount = ui.unmount;
    return ui;
  }

  // A footer that wraps produces a second row carrying the "Esc cancel" tail; a truncated footer
  // keeps only the "Tab field" head. Counting both markers distinguishes one row from two.
  function footerRowCount(frame: string | undefined): number {
    return (frame ?? '').split('\n').filter((line) => /tab field|esc cancel/.test(line)).length;
  }

  it('keeps the controls hint on one row at a narrow inner width with a full field and save error', async () => {
    // Inner width 54 (< ~70) is where the raw hint would soft-wrap. Fill the field past its clamped
    // viewport and surface a save error so identity + field + error + footer all compete for the
    // fixed region; the footer must still occupy exactly one row so no field row is clipped.
    const task = validTask({ title: 'x'.repeat(300), tests: ['works'] });
    const ui = renderAtWidth(task, 54, 8);
    await tick(20);

    ui.stdin.write(CTRL_S);
    await tick(20);

    const frame = ui.lastFrame();
    expect(frame).toContain('tab field');
    expect(frame).toMatch(/vague|round-trip/);
    // Exactly one footer row (reverting the truncate guard yields two: head + "Esc cancel" tail).
    expect(footerRowCount(frame)).toBe(1);
    // The whole surface fits its reserved region — an extra footer row would exceed height 8.
    const lineCount = (frame ?? '').split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(8);
  });

  it('negative control: at a wide inner width the same hint already fits one row', async () => {
    // At 120 cols the full ~70-col hint fits on one row with or without the guard, so this width
    // never clips — proving the narrow-width single-row assertion is the discriminating case.
    const task = validTask({ tests: ['works'] });
    const ui = renderAtWidth(task, 120, 8);
    await tick(20);

    ui.stdin.write(CTRL_S);
    await tick(20);

    const frame = ui.lastFrame();
    expect(frame).toContain('esc cancel');
    expect(footerRowCount(frame)).toBe(1);
  });
});
