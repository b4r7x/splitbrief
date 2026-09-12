import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { renderFeature, flushEffects, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { ApprovalReviewResult } from '../../../src/core/approval/types.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import { formatTasks } from '../../../src/engine/spec/formatter.js';
import { REVIEW_HINT } from '../../../src/features/workflow/review-commands.js';
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
const { feedbackStore } = await import('../../../src/stores/ui/feedback.js');
const { reviewStore } = await import('../../../src/stores/workflow/review.js');
const { externalEditRequestStore } = await import(
  '../../../src/stores/ui/external-edit-request.js'
);
const { abortStore } = await import('../../../src/stores/workflow/abort.js');

const ENTER = '\r';
const CTRL_E = '\x05';
const REVIEW_EDITOR_WAIT_MS = 15_000;

async function waitForReviewPrompt(ui: { lastFrame: () => string | undefined }, timeout?: number) {
  await vi.waitFor(() => {
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('approve');
    expect(frame).toContain('e edit');
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

  it('brief review uses the simple review surface and workflow footer', async () => {
    const projectDir = createTempDir('workflow-screen-review-footer');
    try {
      const tasksPath = join(projectDir, 'tasks.md');
      writeFileSync(
        tasksPath,
        formatTasks([
          makeTask({
            id: 'T001',
            title: 'Simple footer task',
            file: 'src/review-footer.ts',
            evidence: ['reviewable proof'],
            scope: { inBounds: ['src/review-footer.ts'], outOfBounds: [] },
          }),
        ]),
        'utf-8',
      );
      const config = makeConfig({ workflow: { briefReview: 'simple' } });
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
        execution: { kind: 'local', prepared },
      });
      runWorkflow.mockImplementationOnce(async (opts) => {
        lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
        await opts.callbacks.onApprovalNeeded('briefs', tasksPath);
        return makeSummary({ feature: 'review footer review' });
      });

      const ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      );

      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('Simple footer task');
        expect(ui.lastFrame() ?? '').toContain(REVIEW_HINT);
      });
      const frame = ui.lastFrame() ?? '';
      // Ctrl+C is hinted only by the armed FeedbackRow, never by the resting InputFooter.
      expect(frame).not.toContain('Ctrl+C');
      expect(frame).not.toContain('tab sections');

      abortStore.arm('exit');
      await tick(20);
      expect(ui.lastFrame() ?? '').toContain('ctrl+c again to exit');
      abortStore.clear();

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('the edit command opens the external editor for brief review and resolves the edit action', async () => {
    const projectDir = createTempDir('workflow-screen-brief-shortcut');
    try {
      const tasksPath = join(projectDir, 'tasks.md');
      const { editorPath, logPath } = writeFakeReviewEditor(projectDir);
      const editedText = formatTasks([
        makeTask({
          id: 'T001',
          title: 'Review shortcut task edited',
          file: 'src/review-shortcut.ts',
          evidence: ['reviewable proof'],
          scope: { inBounds: ['src/review-shortcut.ts'], outOfBounds: [] },
        }),
      ]);
      writeFileSync(
        tasksPath,
        formatTasks([
          makeTask({
            id: 'T001',
            title: 'Review shortcut task',
            file: 'src/review-shortcut.ts',
            evidence: ['reviewable proof'],
            scope: { inBounds: ['src/review-shortcut.ts'], outOfBounds: [] },
          }),
        ]),
        'utf-8',
      );
      stubReviewEditor(editorPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_LOG', logPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_CONTENT', editedText);
      let approvalResult: ApprovalReviewResult | undefined;

      runWorkflow.mockImplementationOnce(async (opts) => {
        lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
        approvalResult = await opts.callbacks.onApprovalNeeded('briefs', tasksPath);
        return makeSummary();
      });
      const ui = mountWorkflow(projectDir);

      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('Review shortcut task');
      });
      await waitForReviewPrompt(ui);

      const ownerToken = reviewStore.get().ownerToken;
      externalEditRequestStore.request(ownerToken);
      await tick(20);

      await vi.waitFor(() => {
        expect(readFileSync(logPath, 'utf-8').trim()).toBe(tasksPath);
      }, REVIEW_EDITOR_WAIT_MS);
      await vi.waitFor(() => {
        expect(approvalResult).toEqual({ approved: false, action: 'edit' });
      }, REVIEW_EDITOR_WAIT_MS);
      expect(readFileSync(tasksPath, 'utf-8')).toContain('Review shortcut task edited');

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('Ctrl+E opens the inline raw editor for brief review and does not spawn the external editor', async () => {
    const projectDir = createTempDir('workflow-screen-brief-inline');
    try {
      const { editorPath, logPath } = writeFakeReviewEditor(projectDir);
      // The brief file Ctrl+E edits is a session artifact: the inline editor reads it through the
      // session confinement, so a repo-root path would be refused the way production refuses one.
      // The run owns the session directory, so the file is written once the run has allocated it.
      const tasksPath = join(sessionDir(projectDir, WORKFLOW_SCREEN_SESSION_ID), 'tasks.md');
      stubReviewEditor(editorPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_LOG', logPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_CONTENT', 'inline-must-not-spawn');

      runWorkflow.mockImplementationOnce(async (opts) => {
        writeFileSync(
          tasksPath,
          formatTasks([
            makeTask({
              id: 'T001',
              title: 'Inline shortcut task',
              file: 'src/inline-shortcut.ts',
              evidence: ['reviewable proof'],
              scope: { inBounds: ['src/inline-shortcut.ts'], outOfBounds: [] },
            }),
          ]),
          'utf-8',
        );
        lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
        void opts.callbacks.onApprovalNeeded('briefs', tasksPath);
        return makeSummary();
      });
      const ui = mountWorkflow(projectDir);

      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('Inline shortcut task');
      });
      await flushEffects();

      ui.stdin.write(CTRL_E);

      await vi.waitFor(() => {
        expect(editorStore.get().status).toBe('open');
      });
      const session = editorStore.get();
      expect(session.status === 'open' ? session.surface : null).toBe('raw');
      expect(session.status === 'open' ? session.value : null).toContain('Inline shortcut task');
      // Single owner (REQ-049 / CON-D): Ctrl+E is the inline editor's alone; it must not also
      // fire the composer's external-editor path, so the fake $EDITOR is never spawned.
      expect(existsSync(logPath)).toBe(false);

      editorStore.close();
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it.each([
    ['spec', 'reviewing-spec'],
    ['plan', 'reviewing-plan'],
  ] as const)(
    'the edit command opens the external editor for %s review and refreshes before approval',
    async (type, phase) => {
      const projectDir = createTempDir(`workflow-screen-${type}-editor`);
      try {
        const reviewPath = join(projectDir, `${type}.md`);
        const { editorPath, logPath } = writeFakeReviewEditor(projectDir);
        const editedText = `# Edited ${type} review\n\nfresh editor content\n`;
        writeFileSync(reviewPath, `# Original ${type} review\n\nstale content\n`, 'utf-8');
        stubReviewEditor(editorPath);
        vi.stubEnv('FAKE_REVIEW_EDITOR_LOG', logPath);
        vi.stubEnv('FAKE_REVIEW_EDITOR_CONTENT', editedText);
        let approvalResult: ApprovalReviewResult | undefined;

        runWorkflow.mockImplementationOnce(async (opts) => {
          lifecycleStore.__testReset({ phase });
          approvalResult = await opts.callbacks.onApprovalNeeded(type, reviewPath);
          return makeSummary({ feature: `${type} review editor` });
        });

        const ui = mountWorkflow(projectDir);

        await vi.waitFor(() => {
          expect(ui.lastFrame() ?? '').toContain(`Original ${type} review`);
        });
        await waitForReviewPrompt(ui);

        await flushEffects();
        ui.stdin.write('edit');
        await vi.waitFor(() => {
          expect(ui.lastFrame() ?? '').toContain('edit');
        }, REVIEW_EDITOR_WAIT_MS);
        await flushEffects();
        ui.stdin.write(ENTER);

        await vi.waitFor(() => {
          expect(readFileSync(logPath, 'utf-8')).toContain(reviewPath);
        }, REVIEW_EDITOR_WAIT_MS);
        await vi.waitFor(() => {
          expect(ui.lastFrame() ?? '').toContain(`Edited ${type} review`);
        }, REVIEW_EDITOR_WAIT_MS);
        expect(readFileSync(reviewPath, 'utf-8')).toContain(`Edited ${type} review`);
        expect(approvalResult).toBeUndefined();

        // "Edited … — content reloaded" owns the feedback row until it auto-clears (3s);
        // the review key legend returns after that.
        await waitForReviewPrompt(ui, REVIEW_EDITOR_WAIT_MS);
        await flushEffects();
        ui.stdin.write('approve');
        await vi.waitFor(() => {
          expect(ui.lastFrame() ?? '').toContain('approve');
        }, REVIEW_EDITOR_WAIT_MS);
        await flushEffects();
        ui.stdin.write(ENTER);

        await vi.waitFor(() => {
          expect(approvalResult).toEqual({ approved: true });
        }, REVIEW_EDITOR_WAIT_MS);

        ui.unmount();
      } finally {
        cleanupTempDir(projectDir);
      }
    },
  );

  it('refreshes the review overlay with an edit the editor saved before exiting non-zero', async () => {
    const projectDir = createTempDir('workflow-screen-spec-editor-failure');
    try {
      const reviewPath = join(projectDir, 'spec.md');
      const { editorPath, logPath } = writeFakeReviewEditor(projectDir);
      writeFileSync(reviewPath, '# Original spec review\n\nstale content\n', 'utf-8');
      stubReviewEditor(editorPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_LOG', logPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_CONTENT', '# Edited spec review\n\nfresh editor content\n');
      vi.stubEnv('FAKE_REVIEW_EDITOR_EXIT_CODE', '1');
      let approvalResult: ApprovalReviewResult | undefined;

      runWorkflow.mockImplementationOnce(async (opts) => {
        lifecycleStore.__testReset({ phase: 'reviewing-spec' });
        approvalResult = await opts.callbacks.onApprovalNeeded('spec', reviewPath);
        return makeSummary({ feature: 'spec review editor failure' });
      });

      const ui = mountWorkflow(projectDir);
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('Original spec review');
      });
      await waitForReviewPrompt(ui);

      const messages: string[] = [];
      const unsubscribe = feedbackStore.subscribe(() => {
        const { message } = feedbackStore.get();
        if (message !== null) messages.push(message);
      });
      try {
        externalEditRequestStore.request(reviewStore.get().ownerToken);
        await vi.waitFor(() => {
          expect(ui.lastFrame() ?? '').toContain('Edited spec review');
        }, REVIEW_EDITOR_WAIT_MS);
      } finally {
        unsubscribe();
      }

      expect(messages).toContain(
        `Editor exited with status 1 (${basename(process.execPath)}) but saved spec.md — content reloaded`,
      );
      expect(approvalResult).toBeUndefined();

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('runs the external-editor handoff exactly once when the requested token still owns the review prompt', async () => {
    const projectDir = createTempDir('workflow-bridge-fresh');
    try {
      const reviewPath = join(projectDir, 'tasks.md');
      writeFileSync(reviewPath, '# Tasks\n', 'utf-8');
      const { editorPath, logPath } = writeFakeReviewEditor(projectDir);
      stubReviewEditor(editorPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_LOG', logPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_CONTENT', '# Tasks\n');

      const ui = mountWorkflow(projectDir);
      await tick(20);

      const token = reviewStore.setReviewFile(reviewPath);
      externalEditRequestStore.request(token);
      await tick(20);

      await vi.waitFor(() => {
        expect(readFileSync(logPath, 'utf-8').trim()).toBe(reviewPath);
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
      externalEditRequestStore.request(staleToken);
      await tick(40);

      expect(existsSync(logPath)).toBe(false);
      expect(externalEditRequestStore.get().status).toBe('idle');

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
