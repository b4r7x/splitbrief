import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { resolveReviewerRunner } from '../../src/core/config/accessors/reviewer-runner.js';
import {
  inlineRunnerCommand,
  isCustomCommandRunner,
} from '../../src/core/config/custom-commands.js';
import {
  inlineRunnerSecurityPosture,
  readCustomRunnerTrust,
} from '../../src/engine/runners/custom-trust.js';
import { makeConfig } from './factories/config.js';
import { trustDeclaredRunners } from './runner-trust.js';
import { withTempDir } from './temp-dir.js';

it.each([
  { kind: 'shell', source: 'configured' },
  { kind: 'agent', source: 'configured' },
  { kind: 'shell', source: 'planner' },
] as const)('trusts a $kind review seat from the $source runner', async ({ kind, source }) => {
  await withTempDir('send-now-reviewer-trust', async (directory) => {
    const projectDir = join(directory, 'project');
    mkdirSync(projectDir);
    const stateDir = join(directory, 'state');
    const runner = {
      kind,
      command: process.execPath,
      args: ['--version'],
      outputFormat: 'text' as const,
    };
    const config = makeConfig(source === 'configured' ? { reviewer: runner } : { planner: runner });
    await trustDeclaredRunners({ projectDir, config, stateDir });
    const reviewer = resolveReviewerRunner(config);
    expect(reviewer.source).toBe(source);
    if (!isCustomCommandRunner(reviewer.runner)) throw new Error('Expected a custom reviewer');
    const command = inlineRunnerCommand({ runner: reviewer.runner, role: 'planner' });
    expect(
      await readCustomRunnerTrust({
        projectDir,
        stateDir,
        runner: { source: 'inline', command },
        posture: inlineRunnerSecurityPosture('planner', command.contract),
      }),
    ).toMatchObject({ kind: 'match' });
  });
});
