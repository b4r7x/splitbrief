import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderFeature, flushEffects, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { ApprovalReviewResult } from '../../../src/core/approval/types.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import { REVIEW_DOCUMENT_HINTS } from '../../../src/features/workflow/prompt-rows/approval.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import { mountWorkflowScreen, prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { sessionDir } from '../../../src/core/paths.js';

/** The session `mountWorkflowScreen` prepares; a session artifact lives under its directory. */
const WORKFLOW_SCREEN_SESSION_ID = 'workflow-screen-session';

const runWorkflow = vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>();
const workflowDeps = { runWorkflow };

const { configStore } = await import('../../../src/stores/project/config.js');
const { terminalSizeStore } = await import('../../../src/stores/ui/terminal-size.js');
const { routerStore } = await import('../../../src/stores/navigation/router.js');
const { lifecycleStore } = await import('../../../src/stores/workflow/lifecycle.js');
const { editorStore } = await import('../../../src/stores/ui/editor.js');
const { reviewStore } = await import('../../../src/stores/workflow/review.js');
const { externalEditRequestStore } = await import(
  '../../../src/stores/ui/external-edit-request.js'
);

const ENTER = '\r';
const CTRL_E = '\x05';
const REVIEW_EDITOR_WAIT_MS = 15_000;

async function waitForReviewPrompt(ui: { lastFrame: () => string | undefined }, timeout?: number) {
  await vi.waitFor(() => {
    // The document gate is its own legend: the panel names the keys, the composer takes a comment.
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Approve');
    expect(frame).toContain(REVIEW_DOCUMENT_HINTS);
  }, timeout);
  await tick(20);
}

function mountWorkflow(projectDir: string) {
  return mountWorkflowScreen({ deps: workflowDeps, projectDir });
}

function writeFakeReviewEditor(projectDir: string): { editorPath: string; logPath: string } {
  const editorPath = join(projectDir, 'fake-review-editor.cjs');
  const logPath = join(projectDir, 'fake-review-editor.log');
  writeFileSync(
    editorPath,
    `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const filePath = process.argv[2];
appendFileSync(process.env.FAKE_REVIEW_EDITOR_LOG, filePath + '\\n');
writeFileSync(filePath, process.env.FAKE_REVIEW_EDITOR_CONTENT);
process.exit(Number(process.env.FAKE_REVIEW_EDITOR_EXIT_CODE ?? 0));
`,
    'utf-8',
  );
  chmodSync(editorPath, 0o700);
  return { editorPath, logPath };
}

function stubReviewEditor(editorPath: string) {
  vi.stubEnv('VISUAL', '');
  // Prefer `node <script>` over a shebang executable so spawn does not depend on
  // PATH/`env` under parallel vitest forks (GUI editor fallback can hang otherwise).
  vi.stubEnv('EDITOR', `${process.execPath} ${editorPath}`);
}

describe('WorkflowScreen review editing', () => {
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    // The editor handover writes real cursor sequences to process.stdout on every
    // suspend/resume; swallow them so spawning tests don't leak ANSI codes into the
    // test terminal. Ink renders through renderFeature's capture streams, not this one.
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    resetAllStores();
    routerStore.init({ screen: 'home' });
    runWorkflow.mockReset();
    runWorkflow.mockReturnValue(new Promise<never>(() => {}));
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    vi.unstubAllEnvs();
    resetAllStores();
    routerStore.init({ screen: 'home' });
  });

  it('the plan card uses the simple review surface and workflow footer', async () => {
    const projectDir = createTempDir('workflow-screen-review-footer');
    try {
      const planPath = join(projectDir, 'plan.md');
      writeFileSync(planPath, '# Plan\n\nSimple footer plan\n', 'utf-8');
      const config = makeConfig();
      const prepared = prepareWorkflowExecution({
        projectDir,
        feature: 'review footer review',
        config,
        sessionId: 'review-footer-review',
      });
      configStore.__testReset({ config, projectDir });
      terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
      routerStore.navigate({
        to: 'workflow',
        run: makeRunRecord(),
        execution: { kind: 'local', prepared },
      });
      runWorkflow.mockImplementationOnce(async (opts) => {
        lifecycleStore.__testReset({ phase: 'reviewing-plan' });
        await opts.callbacks.onApprovalNeeded('plan', planPath, []);
        return makeSummary({ feature: 'review footer review' });
      });

      const ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      );

      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('Simple footer plan');
        expect(ui.lastFrame() ?? '').toContain(REVIEW_DOCUMENT_HINTS);
      });
      const frame = ui.lastFrame() ?? '';
      // The gate panel is the only legend on screen: the resting footer adds nothing beside it.
      expect(frame).not.toContain('Ctrl+C');
      expect(frame).not.toContain('tab sections');

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('an external edit at the plan card opens plan.json and resolves the edit action', async () => {
    const projectDir = createTempDir('workflow-screen-plan-external');
    try {
      const planPath = join(projectDir, 'plan.md');
      const planJsonPath = join(projectDir, 'plan.json');
      const { editorPath, logPath } = writeFakeReviewEditor(projectDir);
      writeFileSync(planPath, '# Plan\n\nExternal shortcut plan\n', 'utf-8');
      writeFileSync(planJsonPath, '{}\n', 'utf-8');
      stubReviewEditor(editorPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_LOG', logPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_CONTENT', '{"edited":true}\n');
      let approvalResult: ApprovalReviewResult | undefined;

      runWorkflow.mockImplementationOnce(async (opts) => {
        lifecycleStore.__testReset({ phase: 'reviewing-plan' });
        approvalResult = await opts.callbacks.onApprovalNeeded('plan', planPath, []);
        return makeSummary();
      });
      const ui = mountWorkflow(projectDir);

      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('External shortcut plan');
      });
      await waitForReviewPrompt(ui);

      externalEditRequestStore.request(reviewStore.get().ownerToken, '{}\n');
      await tick(20);

      await vi.waitFor(() => {
        expect(readFileSync(logPath, 'utf-8').trim()).toBe(planJsonPath);
      }, REVIEW_EDITOR_WAIT_MS);
      await vi.waitFor(() => {
        expect(approvalResult).toEqual({ approved: false, action: 'edit' });
      }, REVIEW_EDITOR_WAIT_MS);
      expect(readFileSync(planJsonPath, 'utf-8')).toContain('"edited":true');

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it.each([
    ['Ctrl+E', CTRL_E],
    ['the edit command', 'edit'],
  ] as const)('%s opens plan.json in the editor overlay at the plan card', async (_name, keys) => {
    const projectDir = createTempDir('workflow-screen-plan-inline');
    try {
      const { editorPath, logPath } = writeFakeReviewEditor(projectDir);
      const dir = sessionDir(projectDir, WORKFLOW_SCREEN_SESSION_ID);
      const planPath = join(dir, 'plan.md');
      stubReviewEditor(editorPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_LOG', logPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_CONTENT', 'inline-must-not-spawn');

      runWorkflow.mockImplementationOnce(async (opts) => {
        writeFileSync(planPath, '# Plan\n\nInline shortcut plan\n', 'utf-8');
        writeFileSync(join(dir, 'plan.json'), '{"summary":"inline plan json"}\n', 'utf-8');
        lifecycleStore.__testReset({ phase: 'reviewing-plan' });
        // The run stays in flight while the gate waits, exactly as it does in production: a mock
        // that returned first would settle the route and take the gate off screen.
        await opts.callbacks.onApprovalNeeded('plan', planPath, []);
        return makeSummary();
      });
      const ui = mountWorkflow(projectDir);

      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('Inline shortcut plan');
      });
      await waitForReviewPrompt(ui);

      await flushEffects();
      ui.stdin.write(keys);
      if (keys === 'edit') {
        await flushEffects();
        ui.stdin.write(ENTER);
      }

      await vi.waitFor(() => {
        expect(editorStore.get().status).toBe('open');
      });
      const session = editorStore.get();
      expect(session.status === 'open' ? session.filePath : null).toBe(join(dir, 'plan.json'));
      expect(session.status === 'open' ? session.value : null).toContain('inline plan json');
      // The overlay is the editor: the fake $EDITOR is never spawned.
      expect(existsSync(logPath)).toBe(false);

      editorStore.close();
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('runs the external-editor handoff exactly once when the requested token still owns the review prompt', async () => {
    const projectDir = createTempDir('workflow-bridge-fresh');
    try {
      const reviewPath = join(projectDir, 'plan.md');
      const editPath = join(projectDir, 'plan.json');
      writeFileSync(reviewPath, '# Plan\n', 'utf-8');
      writeFileSync(editPath, '{}\n', 'utf-8');
      const { editorPath, logPath } = writeFakeReviewEditor(projectDir);
      stubReviewEditor(editorPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_LOG', logPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_CONTENT', '{}\n');

      const ui = mountWorkflow(projectDir);
      await tick(20);

      // The plan card shows plan.md; the edit it hands the external editor is plan.json.
      lifecycleStore.__testReset({ phase: 'reviewing-plan' });
      const token = reviewStore.setReviewFile(reviewPath);
      externalEditRequestStore.request(token, '{}\n');
      await tick(20);

      await vi.waitFor(() => {
        expect(readFileSync(logPath, 'utf-8').trim()).toBe(editPath);
      }, REVIEW_EDITOR_WAIT_MS);
      expect(externalEditRequestStore.get().status).toBe('idle');

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('drops a stale request whose token no longer owns the review prompt (CAS, no handoff)', async () => {
    const projectDir = createTempDir('workflow-bridge-stale');
    try {
      const reviewPath = join(projectDir, 'tasks.md');
      const otherPath = join(projectDir, 'plan.md');
      writeFileSync(reviewPath, '# Tasks\n', 'utf-8');
      writeFileSync(otherPath, '# Plan\n', 'utf-8');
      const { editorPath, logPath } = writeFakeReviewEditor(projectDir);
      stubReviewEditor(editorPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_LOG', logPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_CONTENT', '# edited\n');

      const ui = mountWorkflow(projectDir);
      await tick(20);

      const staleToken = reviewStore.setReviewFile(reviewPath);
      reviewStore.setReviewFile(otherPath);
      externalEditRequestStore.request(staleToken, '{}\n');
      await tick(40);

      expect(existsSync(logPath)).toBe(false);
      expect(externalEditRequestStore.get().status).toBe('idle');

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
