import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SESSIONS_DIR, SPLITBRIEF_DIR, reviewPacketMarkdownPath } from '../../../src/core/paths.js';
import { startReadinessWarnings } from '../../../src/core/readiness/format.js';
import { readReadinessArtifact } from '../../../src/engine/orchestrator/evidence/review-packet/artifacts.js';
import { makeE2eScenarioConfig } from '../helpers/config.js';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/harness.js';

const scenario = {
  name: 'checkout mode - start warning on a dirty checkout',
  cassetteName: 'quick-trivial-edit',
  feature: 'fix typo in README',
  config: makeE2eScenarioConfig({ workflow: { isolation: 'none' } }),
};

describe('e2e: a checkout-mode run started on uncommitted edits', () => {
  const ctx = setupE2eScenario(scenario);

  it('states the readiness warning under the request and keeps its fix in the run record', async () => {
    writeFileSync(join(ctx.projectDir, 'my-notes.txt'), 'my own notes\n', 'utf-8');

    await runE2eWorkflow(ctx, scenario);

    const [sessionId = ''] = readdirSync(join(ctx.projectDir, SPLITBRIEF_DIR, SESSIONS_DIR));
    const REVERTED = `${SPLITBRIEF_DIR}/${SESSIONS_DIR}/${sessionId}/reverted/`;
    const record = readReadinessArtifact(ctx.projectDir, sessionId);
    if (record === null) throw new Error('Missing readiness.json');
    expect(record.checks).toContainEqual({
      id: 'repo.dirty-worktree',
      severity: 'warning',
      summary: 'Working tree has 1 untracked file.',
      details: [
        'Examples: my-notes.txt',
        'An attempt revert restores only the paths that attempt changed.',
      ],
      remediation: `The run edits this checkout. A revert saves the files it replaces in ${REVERTED}. Commit or stash the edits you do not want this run to touch.`,
    });

    const stated = startReadinessWarnings(record);
    expect(stated).toContainEqual(expect.stringContaining('The run edits this checkout.'));
    const request = ctx.events.findIndex((event) => event.type === 'user_message');
    expect(
      ctx.events
        .slice(request + 1, request + 1 + stated.length)
        .map((event) => (event.type === 'warning' ? event.message : event.type)),
    ).toEqual(stated);
    const warnings = ctx.events.filter(
      (event) => event.type === 'warning' && event.message.includes(REVERTED),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      message: expect.stringContaining('\nExamples: my-notes.txt\n'),
    });

    const packet = readFileSync(
      reviewPacketMarkdownPath({ projectDir: ctx.projectDir, sessionId }),
      'utf-8',
    );
    expect(packet).toContain('- warning repo.dirty-worktree: Working tree has 1 untracked file.');
    expect(packet).toContain(`  - Fix: The run edits this checkout.`);
    expect(packet).toContain(REVERTED);
  });
});
