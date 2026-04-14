import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPlannerBase } from './base.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/fixtures.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

let projectDir: string;

const minimalTask = makeTask();

beforeEach(() => {
  projectDir = createTempDir('planner-base-test');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createPlannerBase — phase artifact content', () => {
  it('phases[].text contains resolved artifact when readPhaseOutput is provided', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: 'raw stdout noise', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
      isAvailable: async () => true,
      readPhaseOutput: (_filename, _resultText, _projectDir) => '# Resolved artifact content',
    });

    const result = await planner.plan('feature', projectDir, { onOutput: () => {} });
    for (const phase of result.phases ?? []) {
      expect(phase.text).toBe('# Resolved artifact content');
      expect(phase.rawOutput).toBe('raw stdout noise');
    }
  });

  it('phases[].text equals stdout when no readPhaseOutput hook is provided', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '# Direct stdout content', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
      isAvailable: async () => true,
    });

    const result = await planner.plan('feature', projectDir, { onOutput: () => {} });
    for (const phase of result.phases ?? []) {
      expect(phase.text).toBe('# Direct stdout content');
      expect(phase.rawOutput).toBeUndefined();
    }
  });

  it('quickPlan phases[].text contains resolved artifact from readPhaseOutput', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: 'raw quick output', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
      isAvailable: async () => true,
      readPhaseOutput: (_filename, _resultText, _projectDir) => `---
id: t1
title: Test task
action: create
file: test.ts
---

### Description
A test task.

### Tests
- pass

### Constraints
- none
`,
    });

    const result = await planner.quickPlan('feature', projectDir, { onOutput: () => {} });
    expect(result.phases).toHaveLength(1);
    expect(result.phases![0]!.text).toContain('id: t1');
    expect(result.phases![0]!.rawOutput).toBe('raw quick output');
  });
});

describe('createPlannerBase — hintSuccessMode', () => {
  it('hintSuccessMode: "files" — succeeds when files are written', async () => {
    const outFile = join(projectDir, 'hint-out.ts');
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => {
        writeFileSync(outFile, '// written by escalation');
        return { text: '', usage: null };
      },
      isAvailable: async () => true,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint(minimalTask, 'error', projectDir, { onOutput: () => {} });
    expect(result.success).toBe(true);
  });

  it('hintSuccessMode: "files" — fails when no files are written', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
      isAvailable: async () => true,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint(minimalTask, 'error', projectDir, { onOutput: () => {} });
    expect(result.success).toBe(false);
  });

  it('hintSuccessMode: "text" (default) — succeeds when text is non-empty', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: 'some hint output', usage: null }),
      isAvailable: async () => true,
    });

    const result = await planner.escalateHint(minimalTask, 'error', projectDir, { onOutput: () => {} });
    expect(result.success).toBe(true);
  });

  it('hintSuccessMode: "text" (default) — fails when text is empty', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
      isAvailable: async () => true,
    });

    const result = await planner.escalateHint(minimalTask, 'error', projectDir, { onOutput: () => {} });
    expect(result.success).toBe(false);
  });

  it('supportsHintEscalation: false — always returns success: false', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: 'lots of output', usage: null }),
      isAvailable: async () => true,
      supportsHintEscalation: false,
    });

    const result = await planner.escalateHint(minimalTask, 'error', projectDir, { onOutput: () => {} });
    expect(result.success).toBe(false);
  });

  it('hintSuccessMode: "files" — ignores pre-existing dirty files (before/after snapshot)', async () => {
    // A file is dirty BEFORE escalation runs
    const preExisting = join(projectDir, 'pre-existing.ts');
    writeFileSync(preExisting, '// dirty before escalation');

    // Escalation writes a NEW file only
    const newFile = join(projectDir, 'new-from-hint.ts');
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => {
        writeFileSync(newFile, '// written by hint');
        return { text: '', usage: null };
      },
      isAvailable: async () => true,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint(minimalTask, 'error', projectDir, { onOutput: () => {} });
    // The new file is what triggered success — pre-existing dirty file is baseline, not a signal
    expect(result.success).toBe(true);
  });

  it('hintSuccessMode: "files" — not success when only pre-existing dirty files remain', async () => {
    // A file is dirty BEFORE escalation AND escalation writes nothing new
    const preExisting = join(projectDir, 'pre-existing-only.ts');
    writeFileSync(preExisting, '// dirty before escalation');

    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
      isAvailable: async () => true,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint(minimalTask, 'error', projectDir, { onOutput: () => {} });
    expect(result.success).toBe(false);
  });
});
