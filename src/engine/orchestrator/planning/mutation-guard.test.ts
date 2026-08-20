import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  capturePlanningMutationBaseline,
  findUnexpectedPlanningMutations,
} from './mutation-guard.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';

describe('planning mutation guard', () => {
  it('flags unexpected source mutations after planning baseline', async () => {
    const projectDir = createTempDir('planning-mutation-guard');
    createTestGitRepo(projectDir);
    try {
      const baseline = await capturePlanningMutationBaseline(projectDir);
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'leak.ts'), 'export const leak = true;\n');

      const unexpected = await findUnexpectedPlanningMutations({
        projectDir,
        baseline,
      });
      expect(unexpected).toContain('src/leak.ts');
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('reports a common-basename artifact as a mutation with no tasks.md allowance', async () => {
    const projectDir = createTempDir('planning-mutation-guard-artifact');
    createTestGitRepo(projectDir);
    try {
      const baseline = await capturePlanningMutationBaseline(projectDir);
      writeFileSync(join(projectDir, 'tasks.md'), '# tasks\n');
      mkdirSync(join(projectDir, 'docs'), { recursive: true });
      writeFileSync(join(projectDir, 'docs', 'tasks.md'), '# tasks\n');
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'leak.ts'), 'export const leak = true;\n');

      const unexpected = await findUnexpectedPlanningMutations({
        projectDir,
        baseline,
      });
      expect(unexpected).toEqual(['docs/tasks.md', 'src/leak.ts', 'tasks.md']);
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('ignores declared tool-internal state churn while still flagging real mutations', async () => {
    const projectDir = createTempDir('planning-mutation-guard-internal');
    createTestGitRepo(projectDir);
    try {
      mkdirSync(join(projectDir, '.opencode'), { recursive: true });
      writeFileSync(join(projectDir, '.opencode', 'package-lock.json'), '{"version":1}\n');
      writeFileSync(join(projectDir, '.opencode', 'package.json'), '{"name":"opencode"}\n');
      mkdirSync(join(projectDir, '.opencode', 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(projectDir, '.opencode', 'node_modules', '.bin', 'opencode'), 'tool\n');
      const baseline = await capturePlanningMutationBaseline(projectDir);
      writeFileSync(join(projectDir, '.opencode', 'package-lock.json'), '{"version":2}\n');
      writeFileSync(join(projectDir, '.opencode', 'package.json.bak'), '{"name":"backup"}\n');
      writeFileSync(join(projectDir, '.opencode', 'package-lock.json.evil'), '{"version":3}\n');
      writeFileSync(join(projectDir, '.opencode', 'node_modules', '.bin', 'opencode'), 'updated\n');
      mkdirSync(join(projectDir, '.opencode', 'plugin'), { recursive: true });
      writeFileSync(join(projectDir, '.opencode', 'plugin', 'injected.js'), 'export {};\n');
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'foo.ts'), 'export const foo = true;\n');

      const unexpected = await findUnexpectedPlanningMutations({
        projectDir,
        baseline,
        internalStatePaths: [
          '.opencode/package-lock.json',
          '.opencode/package.json',
          '.opencode/node_modules/',
        ],
      });
      expect(unexpected).toEqual([
        '.opencode/package-lock.json.evil',
        '.opencode/package.json.bak',
        '.opencode/plugin/injected.js',
        'src/foo.ts',
      ]);

      const undeclared = await findUnexpectedPlanningMutations({
        projectDir,
        baseline,
      });
      expect(undeclared).toContain('.opencode/package-lock.json');
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('does not report session-state churn because internal git status paths stay invisible', async () => {
    const projectDir = createTempDir('planning-mutation-guard-session');
    const sessionId = 'sess-guard';
    createTestGitRepo(projectDir);
    ensureSessionDir(projectDir, sessionId);
    try {
      const baseline = await capturePlanningMutationBaseline(projectDir);
      writeFileSync(join(projectDir, '.splitbrief', 'sessions', sessionId, 'spec.md'), '# spec\n');

      const unexpected = await findUnexpectedPlanningMutations({
        projectDir,
        baseline,
      });
      expect(unexpected).toEqual([]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
