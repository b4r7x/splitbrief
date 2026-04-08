import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveState, loadState, appendEvent } from './persistence.js';
import { createInitialState } from './machine.js';
import type { OrchestratorEvent } from '../types/index.js';

let tmp: string;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function makeTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), 'state-persist-'));
  return tmp;
}

describe('saveState / loadState roundtrip', () => {
  it('writes JSON and reads it back identically', () => {
    const dir = makeTmp();
    const state = createInitialState('my-feature');
    saveState(dir, state);
    const loaded = loadState(dir);
    expect(loaded).toEqual(state);
  });

  it('creates .tiny-spec/current/ directory when it does not exist', () => {
    const dir = makeTmp();
    const nested = join(dir, 'deep', 'nested');
    // nested doesn't exist yet
    expect(existsSync(nested)).toBe(false);
    saveState(nested, createInitialState('feat'));
    expect(existsSync(join(nested, '.tiny-spec', 'current', 'state.json'))).toBe(true);
  });
});

describe('loadState', () => {
  it('returns null when file does not exist', () => {
    const dir = makeTmp();
    expect(loadState(dir)).toBeNull();
  });
});

describe('appendEvent', () => {
  it('appends JSONL lines to events file', () => {
    const dir = makeTmp();
    const event1: OrchestratorEvent = { ts: 1000, type: 'task_started', taskId: 'T001', phase: 'implementing' };
    const event2: OrchestratorEvent = { ts: 2000, type: 'task_completed', taskId: 'T001', phase: 'implementing' };

    appendEvent(dir, event1);
    appendEvent(dir, event2);

    const raw = readFileSync(join(dir, '.tiny-spec', 'current', 'events.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(event1);
    expect(JSON.parse(lines[1])).toEqual(event2);
  });

  it('creates directory when it does not exist', () => {
    const dir = makeTmp();
    const event: OrchestratorEvent = { ts: 1000, type: 'workflow_started', phase: 'idle' };
    appendEvent(dir, event);
    expect(existsSync(join(dir, '.tiny-spec', 'current', 'events.jsonl'))).toBe(true);
  });
});
