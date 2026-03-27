import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TuiEvent } from '../src/types.js';

describe('TuiEvent', () => {
  describe('planner-status', () => {
    it('constructs with required fields', () => {
      const event: TuiEvent = { type: 'planner-status', ts: Date.now(), phase: 'researching', status: 'running' };
      assert.equal(event.type, 'planner-status');
      assert.equal(typeof event.ts, 'number');
      assert.equal(event.phase, 'researching');
      assert.equal(event.status, 'running');
    });

    it('accepts optional summary and duration', () => {
      const event: TuiEvent = { type: 'planner-status', ts: 1000, phase: 'specifying', status: 'done', summary: 'Spec complete', duration: 5000 };
      assert.equal(event.type, 'planner-status');
      if (event.type === 'planner-status') {
        assert.equal(event.summary, 'Spec complete');
        assert.equal(event.duration, 5000);
      }
    });
  });

  describe('planner-text', () => {
    it('constructs with required fields', () => {
      const event: TuiEvent = { type: 'planner-text', ts: Date.now(), text: 'Analyzing codebase...' };
      assert.equal(event.type, 'planner-text');
      assert.equal(typeof event.ts, 'number');
      if (event.type === 'planner-text') {
        assert.equal(event.text, 'Analyzing codebase...');
      }
    });
  });

  describe('task-start', () => {
    it('constructs with required fields', () => {
      const event: TuiEvent = { type: 'task-start', ts: Date.now(), taskId: 'T001', title: 'Add auth', index: 0, total: 5, file: 'src/auth.ts', action: 'create' };
      assert.equal(event.type, 'task-start');
      assert.equal(typeof event.ts, 'number');
      if (event.type === 'task-start') {
        assert.equal(event.taskId, 'T001');
        assert.equal(event.title, 'Add auth');
        assert.equal(event.index, 0);
        assert.equal(event.total, 5);
        assert.equal(event.file, 'src/auth.ts');
        assert.equal(event.action, 'create');
      }
    });

    it('accepts modify action', () => {
      const event: TuiEvent = { type: 'task-start', ts: 1000, taskId: 'T002', title: 'Update config', index: 1, total: 5, file: 'src/config.ts', action: 'modify' };
      if (event.type === 'task-start') {
        assert.equal(event.action, 'modify');
      }
    });
  });

  describe('task-complete', () => {
    it('constructs with required fields', () => {
      const event: TuiEvent = { type: 'task-complete', ts: Date.now(), taskId: 'T001', title: 'Add auth', method: 'local', retries: 0, duration: 3000 };
      assert.equal(event.type, 'task-complete');
      assert.equal(typeof event.ts, 'number');
      if (event.type === 'task-complete') {
        assert.equal(event.taskId, 'T001');
        assert.equal(event.title, 'Add auth');
        assert.equal(event.method, 'local');
        assert.equal(event.retries, 0);
        assert.equal(event.duration, 3000);
      }
    });

    it('accepts escalated method', () => {
      const event: TuiEvent = { type: 'task-complete', ts: 1000, taskId: 'T001', title: 'Add auth', method: 'escalated', retries: 2, duration: 10000 };
      if (event.type === 'task-complete') {
        assert.equal(event.method, 'escalated');
        assert.equal(event.retries, 2);
      }
    });
  });

  describe('task-skipped', () => {
    it('constructs with required fields', () => {
      const event: TuiEvent = { type: 'task-skipped', ts: Date.now(), taskId: 'T003', title: 'Optional step', reason: 'dependency failed' };
      assert.equal(event.type, 'task-skipped');
      assert.equal(typeof event.ts, 'number');
      if (event.type === 'task-skipped') {
        assert.equal(event.taskId, 'T003');
        assert.equal(event.title, 'Optional step');
        assert.equal(event.reason, 'dependency failed');
      }
    });
  });

  describe('implementer-generate', () => {
    it('constructs with required fields', () => {
      const event: TuiEvent = { type: 'implementer-generate', ts: Date.now(), status: 'running' };
      assert.equal(event.type, 'implementer-generate');
      assert.equal(typeof event.ts, 'number');
      if (event.type === 'implementer-generate') {
        assert.equal(event.status, 'running');
      }
    });

    it('accepts optional model, file, diff, and duration', () => {
      const event: TuiEvent = {
        type: 'implementer-generate', ts: 1000, status: 'done',
        model: 'qwen2.5-coder:7b', file: 'src/auth.ts', diff: '+export function login() {}', duration: 2000,
      };
      if (event.type === 'implementer-generate') {
        assert.equal(event.model, 'qwen2.5-coder:7b');
        assert.equal(event.file, 'src/auth.ts');
        assert.equal(event.diff, '+export function login() {}');
        assert.equal(event.duration, 2000);
      }
    });

    it('accepts failed status', () => {
      const event: TuiEvent = { type: 'implementer-generate', ts: 1000, status: 'failed' };
      if (event.type === 'implementer-generate') {
        assert.equal(event.status, 'failed');
      }
    });
  });

  describe('validate', () => {
    it('constructs with required fields', () => {
      const event: TuiEvent = { type: 'validate', ts: Date.now(), passed: true, stages: { tsc: true, lint: true, test: true } };
      assert.equal(event.type, 'validate');
      assert.equal(typeof event.ts, 'number');
      if (event.type === 'validate') {
        assert.equal(event.passed, true);
        assert.deepEqual(event.stages, { tsc: true, lint: true, test: true });
      }
    });

    it('accepts optional error and duration', () => {
      const event: TuiEvent = { type: 'validate', ts: 1000, passed: false, stages: { tsc: false, lint: true, test: true }, error: 'TS2322: Type mismatch', duration: 4500 };
      if (event.type === 'validate') {
        assert.equal(event.passed, false);
        assert.equal(event.stages.tsc, false);
        assert.equal(event.error, 'TS2322: Type mismatch');
        assert.equal(event.duration, 4500);
      }
    });
  });

  describe('retry', () => {
    it('constructs with required fields', () => {
      const event: TuiEvent = { type: 'retry', ts: Date.now(), taskId: 'T001', attempt: 2, maxRetries: 3 };
      assert.equal(event.type, 'retry');
      assert.equal(typeof event.ts, 'number');
      if (event.type === 'retry') {
        assert.equal(event.taskId, 'T001');
        assert.equal(event.attempt, 2);
        assert.equal(event.maxRetries, 3);
      }
    });
  });

  describe('escalate', () => {
    it('constructs with tier 1', () => {
      const event: TuiEvent = { type: 'escalate', ts: Date.now(), tier: 1 };
      assert.equal(event.type, 'escalate');
      assert.equal(typeof event.ts, 'number');
      if (event.type === 'escalate') {
        assert.equal(event.tier, 1);
      }
    });

    it('accepts optional hint', () => {
      const event: TuiEvent = { type: 'escalate', ts: 1000, tier: 2, hint: 'Try using the existing auth middleware' };
      if (event.type === 'escalate') {
        assert.equal(event.tier, 2);
        assert.equal(event.hint, 'Try using the existing auth middleware');
      }
    });
  });

  describe('git-commit', () => {
    it('constructs with required fields', () => {
      const event: TuiEvent = { type: 'git-commit', ts: Date.now(), message: 'feat: add user auth' };
      assert.equal(event.type, 'git-commit');
      assert.equal(typeof event.ts, 'number');
      if (event.type === 'git-commit') {
        assert.equal(event.message, 'feat: add user auth');
      }
    });
  });

  describe('error', () => {
    it('constructs with required fields', () => {
      const event: TuiEvent = { type: 'error', ts: Date.now(), message: 'Connection refused' };
      assert.equal(event.type, 'error');
      assert.equal(typeof event.ts, 'number');
      if (event.type === 'error') {
        assert.equal(event.message, 'Connection refused');
      }
    });
  });

  describe('discriminated union narrowing', () => {
    it('narrows correctly in a switch statement', () => {
      const events: TuiEvent[] = [
        { type: 'planner-status', ts: 1, phase: 'researching', status: 'running' },
        { type: 'planner-text', ts: 2, text: 'hello' },
        { type: 'task-start', ts: 3, taskId: 'T1', title: 'A', index: 0, total: 1, file: 'a.ts', action: 'create' },
        { type: 'task-complete', ts: 4, taskId: 'T1', title: 'A', method: 'local', retries: 0, duration: 100 },
        { type: 'task-skipped', ts: 5, taskId: 'T2', title: 'B', reason: 'skipped' },
        { type: 'implementer-generate', ts: 6, status: 'done', model: 'm' },
        { type: 'validate', ts: 7, passed: true, stages: { tsc: true, lint: true, test: true } },
        { type: 'retry', ts: 8, taskId: 'T1', attempt: 1, maxRetries: 3 },
        { type: 'escalate', ts: 9, tier: 1 },
        { type: 'git-commit', ts: 10, message: 'fix' },
        { type: 'error', ts: 11, message: 'oops' },
      ];

      const seen: string[] = [];

      for (const event of events) {
        switch (event.type) {
          case 'planner-status':
            seen.push(`status:${event.phase}`);
            break;
          case 'planner-text':
            seen.push(`text:${event.text}`);
            break;
          case 'task-start':
            seen.push(`start:${event.taskId}:${event.file}`);
            break;
          case 'task-complete':
            seen.push(`complete:${event.taskId}:${event.method}`);
            break;
          case 'task-skipped':
            seen.push(`skipped:${event.taskId}:${event.reason}`);
            break;
          case 'implementer-generate':
            seen.push(`generate:${event.status}:${event.model}`);
            break;
          case 'validate':
            seen.push(`validate:${event.passed}`);
            break;
          case 'retry':
            seen.push(`retry:${event.attempt}/${event.maxRetries}`);
            break;
          case 'escalate':
            seen.push(`escalate:tier${event.tier}`);
            break;
          case 'git-commit':
            seen.push(`commit:${event.message}`);
            break;
          case 'error':
            seen.push(`error:${event.message}`);
            break;
        }
      }

      assert.deepEqual(seen, [
        'status:researching',
        'text:hello',
        'start:T1:a.ts',
        'complete:T1:local',
        'skipped:T2:skipped',
        'generate:done:m',
        'validate:true',
        'retry:1/3',
        'escalate:tier1',
        'commit:fix',
        'error:oops',
      ]);
    });
  });
});
