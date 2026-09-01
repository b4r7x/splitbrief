import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';

describe('transcript-off session artifact privacy', () => {
  it('omits the feature prompt from session metadata, summaries, export, ps, and branch names', async () => {
    vi.useRealTimers();
    const projectDir = createTempDir('session-privacy');
    const uniquePrompt = 'sentinel-privacy-leak-771299';
    createTestGitRepo(projectDir);

    try {
      const { runWorkflow } = await import('../../../src/engine/orchestrator/run/workflow.js');
      const { WORKFLOW_REWIND_ABORT_REASON } = await import(
        '../../../src/engine/orchestrator/run/rewind-authority.js'
      );
      const { generateSessionId } = await import('../../../src/core/sessions/session-id.js');
      const { readActive } = await import('../../../src/core/sessions/active-pointer.js');
      const { parsePreparedConfig } = await import(
        '../../../src/engine/runners/prepared-execution.js'
      );
      const { SPLITBRIEF_DIR, LOCKFILE, SESSIONS_DIR } = await import('../../../src/core/paths.js');
      const { listAllSessions } = await import('../../../src/core/sessions/io.js');
      const { writeSessionHtmlReport } = await import('../../../src/engine/export/collect.js');
      const { psCommand } = await import('../../../src/cli/commands/ps.js');
      const { simpleGit } = await import('simple-git');

      const controller = new AbortController();
      controller.abort(WORKFLOW_REWIND_ABORT_REASON);
      const config = parsePreparedConfig(
        makeConfig({
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: {
            git: { createBranch: true },
            mode: 'quick',
            persistTranscript: false,
          },
        }),
      );
      const sessionId = generateSessionId({
        projectDir,
        feature: uniquePrompt,
        persistTranscript: false,
      });
      const preparationId = 'transcript-off-preparation';
      const active = {
        version: 1 as const,
        sessionId,
        generation: '9a999999-9999-4999-8999-999999999999',
      };
      const summary = await runWorkflow({
        prepared: {
          purpose: 'new-workflow',
          config,
          preparationId,
          report: {
            generatedAt: '2026-08-04T00:00:00.000Z',
            projectDir,
            status: 'ready',
            counts: { ok: 2, info: 0, warning: 0, blocker: 0 },
            nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
            sections: [],
            metadata: {},
          },
          gates: [
            {
              kind: 'cli',
              slot: { role: 'planner' },
              preparationId,
              tool: 'claude-code',
              executable: executableReceipt(),
            },
            {
              kind: 'api',
              slot: { role: 'implementer', profile: 'default' },
              preparationId,
              provider: 'ollama',
              endpointOrigin: 'http://localhost:11434',
            },
          ],
          session: { kind: 'existing', ref: { projectDir, sessionId }, active },
          runtime: {
            feature: uniquePrompt,
            allowRepoRunners: false,
            allowHooks: false,
          },
        },
        callbacks: makeCallbacks().callbacks,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        signal: controller.signal,
        _planner: makePlanner(),
      });

      const sessionsPath = join(projectDir, SPLITBRIEF_DIR, SESSIONS_DIR);
      const sessionIds = readdirSync(sessionsPath);
      expect(sessionIds).toHaveLength(1);
      const persistedSessionId = sessionIds[0] ?? '';
      const sessionPath = join(sessionsPath, persistedSessionId);
      const activeSessionId = readActive(projectDir);
      const lockfile = readFileSync(join(sessionPath, LOCKFILE), 'utf-8');
      const summaryJson = readFileSync(join(sessionPath, 'summary.json'), 'utf-8');
      const sessions = listAllSessions(projectDir);
      const exportResult = writeSessionHtmlReport(sessionPath, persistedSessionId);
      expect(exportResult.status).toBe('ok');
      const html = readFileSync(join(sessionPath, 'report.html'), 'utf-8');

      const psLines: string[] = [];
      const log = vi.spyOn(console, 'log').mockImplementation((line: string) => {
        psLines.push(line);
      });
      try {
        await psCommand({ projectDir });
      } finally {
        log.mockRestore();
      }

      const branch = (await simpleGit(projectDir).status()).current;
      const inspected = [
        persistedSessionId,
        activeSessionId ?? '',
        lockfile,
        summaryJson,
        JSON.stringify(summary),
        JSON.stringify(sessions),
        html,
        psLines.join('\n'),
        branch,
      ].join('\n');

      expect(inspected).not.toContain(uniquePrompt);
      expect(persistedSessionId).toMatch(/^\d{4}-\d{2}-\d{2}-session-[a-f0-9]{12}$/);
      expect(branch).toMatch(/^splitbrief\/session-[a-f0-9]{12}$/);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
