import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAgentPlanner } from './agent.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let projectDir: string;

function setupMockFiles(projectDir: string, sessionId: string, files: Record<string, string>) {
  const sessionDir = join(projectDir, '.diptych', 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(sessionDir, filename), content);
  }
}

beforeEach(() => {
  projectDir = createTempDir('agent-planner-test');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

const defaultAgentConfig = () =>
  makeConfig({ planner: { kind: 'agent', command: 'echo', args: ['test output'] } });

describe('createAgentPlanner', () => {
  it('throws for wrong config kind', () => {
    const config = makeConfig({ planner: { kind: 'shell', command: 'echo' } });
    expect(() => createAgentPlanner(config)).toThrow('Expected agent planner config');
  });

  it('supports regenerate', async () => {
    const config = defaultAgentConfig();
    const planner = createAgentPlanner(config);
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.regenerate({
      prompt: 'test prompt',
      projectDir,
      callbacks,
    });
    expect(result.text).toContain('test output');
    expect(result.usage).toBe(null);
  });

  it('supports escalateHint — success when agent writes files', async () => {
    const outFile = join(projectDir, 'hint-out.ts');
    const config = makeConfig({
      planner: {
        kind: 'agent',
        command: 'bash',
        args: ['-c', `echo "// hint" > ${outFile}`],
        capabilities: { supportsHintEscalation: true },
      },
    });
    const planner = createAgentPlanner(config);
    const task = makeTask();
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.escalateHint({
      task,
      error: 'error message',
      projectDir,
      callbacks,
    });
    expect(result.success).toBe(true);
    expect(result.code).toBe(null);
  });

  it('supports escalateHint — failure when agent writes no files', async () => {
    const config = makeConfig({
      planner: { kind: 'agent', command: 'echo', args: ['test output'] },
    });
    const planner = createAgentPlanner(config);
    const task = makeTask();
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.escalateHint({
      task,
      error: 'error message',
      projectDir,
      callbacks,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe(null);
  });

  it('supports escalateFull — success when agent writes files', async () => {
    const outFile = join(projectDir, 'full-out.ts');
    const config = makeConfig({
      planner: { kind: 'agent', command: 'bash', args: ['-c', `echo "// full" > ${outFile}`] },
    });
    const planner = createAgentPlanner(config);
    const task = makeTask();
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.escalateFull({
      task,
      error: 'error message',
      projectDir,
      callbacks,
    });
    expect(result.success).toBe(true);
    expect(result.code).toBe(null);
  });

  it('supports review', async () => {
    const config = defaultAgentConfig();
    const planner = createAgentPlanner(config);
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.review('review prompt', projectDir, callbacks);
    expect(result.text).toContain('test output');
    expect(result.usage).toBe(null);
  });

  it('supports quickPlan and reads generated tasks file', async () => {
    const config = defaultAgentConfig();
    const planner = createAgentPlanner(config);
    const SESSION_ID = 'test-session-2024';
    const callbacks = { onOutput: vi.fn(), onPhase: vi.fn(), sessionId: SESSION_ID };

    const tasksContent = `---
id: task1
title: Create test
action: create
file: test.ts
---

### Description
Create a test file.

### Tests
- Should create test file

### Constraints
- Use TypeScript
`;
    setupMockFiles(projectDir, SESSION_ID, { 'tasks.md': tasksContent });

    const result = await planner.quickPlan({ feature: 'test feature', projectDir, callbacks });
    expect(result.spec).toBe('');
    expect(result.plan).toBe('');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('task1');
    expect(result.phases).toHaveLength(1);
  });

  it('supports full plan and reads generated files', async () => {
    const config = defaultAgentConfig();
    const planner = createAgentPlanner(config);
    const SESSION_ID = 'test-session-2024';
    const callbacks = { onOutput: vi.fn(), onPhase: vi.fn(), sessionId: SESSION_ID };

    const mockFiles = {
      'research.md': '# Research\nProject analysis...',
      'spec.md': '# Specification\nFeature requirements...',
      'plan.md': '# Plan\nImplementation strategy...',
      'tasks.md': `---
id: task1
title: Create feature
action: create
file: feature.ts
---

### Description
Create the main feature.

### Tests
- Should create feature

### Constraints
- Use TypeScript
`,
    };
    setupMockFiles(projectDir, SESSION_ID, mockFiles);

    const result = await planner.plan({ feature: 'test feature', projectDir, callbacks });
    expect(result.spec).toContain('Feature requirements');
    expect(result.plan).toContain('Implementation strategy');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('task1');
    expect(result.phases).toHaveLength(4);
  });

  it('handles command not found error', async () => {
    const config = makeConfig({ planner: { kind: 'agent', command: 'nonexistent-command-12345' } });
    const planner = createAgentPlanner(config);
    const callbacks = { onOutput: vi.fn() };

    await expect(planner.review('test', projectDir, callbacks)).rejects.toThrow(
      'Agent planner command not found: nonexistent-command-12345',
    );
  });

  it('escalateFull ignores pre-existing dirty files and succeeds only on new writes', async () => {
    const preExistingFile = join(projectDir, 'pre-existing.ts');
    writeFileSync(preExistingFile, '// pre-existing');
    const task = makeTask();
    const callbacks = { onOutput: vi.fn() };

    const noChangePlanner = createAgentPlanner(
      makeConfig({
        planner: { kind: 'agent', command: 'echo', args: ['no changes'] },
      }),
    );

    const noChange = await noChangePlanner.escalateFull({
      task,
      error: 'error message',
      projectDir,
      callbacks,
    });
    expect(noChange.success).toBe(false);

    const newFile = join(projectDir, 'new-from-escalation.ts');
    const config = makeConfig({
      planner: { kind: 'agent', command: 'bash', args: ['-c', `echo "// escalated" > ${newFile}`] },
    });
    const planner = createAgentPlanner(config);

    const result = await planner.escalateFull({
      task,
      error: 'error message',
      projectDir,
      callbacks,
    });
    expect(result.success).toBe(true);
    expect(readFileSync(preExistingFile, 'utf-8')).toBe('// pre-existing');
    expect(readFileSync(newFile, 'utf-8')).toBe('// escalated\n');
  });
});
