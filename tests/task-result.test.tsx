import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Task, ValidationResult } from '../src/types.js';
import { countDiffLines } from '../src/tui/task-result.js';

describe('TaskResult', () => {
  const mockTask: Task = {
    id: 'T1',
    title: 'Add auth',
    action: 'create',
    file: 'src/auth.ts',
    dependsOn: [],
    description: 'Implement auth',
    tests: [],
    constraints: [],
    typeDefs: '',
    implSteps: [],
    status: 'pending',
  };

  const mockValidation: ValidationResult = {
    passed: true,
    stage: 'typecheck',
  };

  it('exports a default function', async () => {
    const mod = await import('../src/tui/task-result.js');
    assert.equal(typeof mod.default, 'function');
  });

  it('exports countDiffLines function', async () => {
    const mod = await import('../src/tui/task-result.js');
    assert.equal(typeof mod.countDiffLines, 'function');
  });

  it('countDiffLines handles +++ and --- prefixes correctly', () => {
    const diff = `--- a/src/auth.ts
+++ b/src/auth.ts
+ new line
- old line
 context`;

    const result = countDiffLines(diff);
    assert.equal(result.added, 1, `should count 1 added line`);
    assert.equal(result.removed, 1, `should count 1 removed line`);
  });

  it('countDiffLines returns zeros for undefined diff', () => {
    const result = countDiffLines(undefined);
    assert.equal(result.added, 0, `should return 0 added`);
    assert.equal(result.removed, 0, `should return 0 removed`);
  });

  it('countDiffLines handles empty diff', () => {
    const result = countDiffLines('');
    assert.equal(result.added, 0, `should return 0 added`);
    assert.equal(result.removed, 0, `should return 0 removed`);
  });

  it('countDiffLines counts multiple lines', () => {
    const diff = `+ line1
+ line2
+ line3
- remove1
- remove2
 context`;

    const result = countDiffLines(diff);
    assert.equal(result.added, 3, `should count 3 added lines`);
    assert.equal(result.removed, 2, `should count 2 removed lines`);
  });
});
