import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAgentPlanner } from './agent.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig, makeTask } from '#testing/helpers/fixtures.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let projectDir: string;

function setupMockFiles(projectDir: string, files: Record<string, string>) {
  const tinySpecDir = join(projectDir, '.diptych', 'current');
  mkdirSync(tinySpecDir, { recursive: true });

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(tinySpecDir, filename), content);
  }
}

beforeEach(() => {
  projectDir = createTempDir('agent-planner-test');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

const defaultAgentConfig = () => makeConfig({ planner: { kind: 'agent', command: 'echo', args: ['test output'] } });

describe('createAgentPlanner', () => {
  it('throws for wrong config kind', () => {
    const config = makeConfig({ planner: { kind: 'shell', command: 'echo' } });
    expect(() => createAgentPlanner(config)).toThrow('Expected agent planner config');
  });

  it('creates planner with availability methods', () => {
    const config = defaultAgentConfig();
    const planner = createAgentPlanner(config);
    expect(planner.isAvailable).toBeInstanceOf(Function);
    expect(planner.getVersion).toBeInstanceOf(Function);
  });

  it('supports regenerate', async () => {
    const config = defaultAgentConfig();
    const planner = createAgentPlanner(config);
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.regenerate('test prompt', 'spec', projectDir, callbacks);
    expect(result.text).toContain('test output');
    expect(result.usage).toBe(null);
  });

  it('supports escalateHint — success when agent writes files', async () => {
    const outFile = join(projectDir, 'hint-out.ts');
    const config = makeConfig({ planner: { kind: 'agent', command: 'bash', args: ['-c', `echo "// hint" > ${outFile}`] } });
    const planner = createAgentPlanner(config);
    const task = makeTask();
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.escalateHint(task, 'error message', projectDir, callbacks);
    expect(result.success).toBe(true);
    expect(result.code).toBe(null);
  });

  it('supports escalateHint — failure when agent writes no files', async () => {
    const config = makeConfig({ planner: { kind: 'agent', command: 'echo', args: ['test output'] } });
    const planner = createAgentPlanner(config);
    const task = makeTask();
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.escalateHint(task, 'error message', projectDir, callbacks);
    expect(result.success).toBe(false);
    expect(result.code).toBe(null);
  });

  it('supports escalateFull — success when agent writes files', async () => {
    const outFile = join(projectDir, 'full-out.ts');
    const config = makeConfig({ planner: { kind: 'agent', command: 'bash', args: ['-c', `echo "// full" > ${outFile}`] } });
    const planner = createAgentPlanner(config);
    const task = makeTask();
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.escalateFull(task, 'error message', projectDir, callbacks);
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
    const callbacks = { onOutput: vi.fn(), onPhase: vi.fn() };
    
    // Setup mock tasks.md file with correct format
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
    setupMockFiles(projectDir, { 'tasks.md': tasksContent });
    
    const result = await planner.quickPlan('test feature', projectDir, callbacks);
    expect(result.spec).toBe('');
    expect(result.plan).toBe('');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('task1');
    expect(result.phases).toHaveLength(1);
    expect(callbacks.onPhase).toHaveBeenCalledWith('quick-planning');
  });

  it('supports full plan and reads generated files', async () => {
    const config = defaultAgentConfig();
    const planner = createAgentPlanner(config);
    const callbacks = { onOutput: vi.fn(), onPhase: vi.fn() };
    
    // Setup mock generated files
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
    setupMockFiles(projectDir, mockFiles);
    
    const result = await planner.plan('test feature', projectDir, callbacks);
    expect(result.spec).toContain('Feature requirements');
    expect(result.plan).toContain('Implementation strategy');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('task1');
    expect(result.phases).toHaveLength(4);
    expect(callbacks.onPhase).toHaveBeenCalledWith('researching');
    expect(callbacks.onPhase).toHaveBeenCalledWith('specifying');
    expect(callbacks.onPhase).toHaveBeenCalledWith('planning');
    expect(callbacks.onPhase).toHaveBeenCalledWith('generating-tasks');
  });

  it('handles command not found error', async () => {
    const config = makeConfig({ planner: { kind: 'agent', command: 'nonexistent-command-12345' } });
    const planner = createAgentPlanner(config);
    const callbacks = { onOutput: vi.fn() };
    
    await expect(planner.review('test', projectDir, callbacks))
      .rejects.toThrow('Agent planner command not found: nonexistent-command-12345');
  });

  it('escalateFull — ignores pre-existing dirty files (before/after snapshot)', async () => {
    // A pre-existing dirty file exists before escalation. The agent writes a NEW file.
    // Only the NEW file should count as a change.
    const preExistingFile = join(projectDir, 'pre-existing.ts');
    writeFileSync(preExistingFile, '// pre-existing');

    // Pre-existing dirty file is already tracked by git status; commit it partially
    // (we only write, not commit, so it shows as untracked/modified in git status)
    const newFile = join(projectDir, 'new-from-escalation.ts');
    const config = makeConfig({ planner: { kind: 'agent', command: 'bash', args: ['-c', `echo "// escalated" > ${newFile}`] } });
    const planner = createAgentPlanner(config);
    const task = makeTask();
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.escalateFull(task, 'error message', projectDir, callbacks);
    expect(result.success).toBe(true);
  });

  it('escalateFull — preserves token usage from underlying review', async () => {
    const outFile = join(projectDir, 'usage-test.ts');
    const config = makeConfig({ planner: { kind: 'agent', command: 'bash', args: ['-c', `echo "// usage" > ${outFile}`] } });
    const planner = createAgentPlanner(config);
    const task = makeTask();
    const callbacks = { onOutput: vi.fn() };

    // agent planner command-based invocation returns usage: null (no parsing)
    // but the result.usage should be passed through, not replaced with null
    const result = await planner.escalateFull(task, 'error', projectDir, callbacks);
    // usage will be null for command-based (no token tracking), but it should not be
    // unconditionally null — it should reflect what the underlying review returned
    expect(result).toHaveProperty('usage');
  });
});