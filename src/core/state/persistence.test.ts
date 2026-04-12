import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { saveState, loadState, appendEvent } from './persistence.js';
import { createInitialState } from './machine.js';
import { taskId } from '../types/workflow.js';
import type { OrchestratorEvent } from '../types/index.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { TINY_SPEC_DIR } from '../paths.js';

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

function makeTmp(): string {
  tmp = createTempDir('state-persist');
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

  it('preserves tool/model fields in roundtrip', () => {
    const dir = makeTmp();
    const state = {
      ...createInitialState('model-test'),
      plannerTool: 'openrouter',
      plannerModel: 'claude-sonnet-4-20250514',
      implementerTool: 'ollama',
      implementerModel: 'qwen2.5-coder:14b',
    };
    saveState(dir, state);
    const loaded = loadState(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.plannerTool).toBe('openrouter');
    expect(loaded!.plannerModel).toBe('claude-sonnet-4-20250514');
    expect(loaded!.implementerTool).toBe('ollama');
    expect(loaded!.implementerModel).toBe('qwen2.5-coder:14b');
  });

  it('creates .tiny-spec/current/ directory when it does not exist', () => {
    const dir = makeTmp();
    const nested = join(dir, 'deep', 'nested');
    // nested doesn't exist yet
    expect(existsSync(nested)).toBe(false);
    saveState(nested, createInitialState('feat'));
    expect(existsSync(join(nested, TINY_SPEC_DIR, 'current', 'state.json'))).toBe(true);
  });
});

describe('loadState', () => {
  it('returns null when file does not exist', () => {
    const dir = makeTmp();
    expect(loadState(dir)).toBeNull();
  });

  it('returns null when state is malformed (missing phase)', () => {
    const dir = makeTmp();
    const stateDir = join(dir, TINY_SPEC_DIR, 'current');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ stateVersion: 2, tasks: [] }));
    expect(loadState(dir)).toBeNull();
  });

  it('returns null when state is malformed (tasks not an array)', () => {
    const dir = makeTmp();
    const stateDir = join(dir, TINY_SPEC_DIR, 'current');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ stateVersion: 2, phase: 'idle', tasks: 'not-array' }));
    expect(loadState(dir)).toBeNull();
  });

  it('returns null when state file contains invalid JSON', () => {
    const dir = makeTmp();
    const stateDir = join(dir, TINY_SPEC_DIR, 'current');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), '{not valid json!!!');
    expect(loadState(dir)).toBeNull();
  });
});

describe('appendEvent', () => {
  it('appends JSONL lines to events file', () => {
    const dir = makeTmp();
    const event1: OrchestratorEvent = { ts: 1000, type: 'task_started', taskId: taskId('T001'), phase: 'implementing', data: {} };
    const event2: OrchestratorEvent = { ts: 2000, type: 'task_completed', taskId: taskId('T001'), phase: 'implementing', data: { method: 'local' } };

    appendEvent(dir, event1);
    appendEvent(dir, event2);

    const raw = readFileSync(join(dir, TINY_SPEC_DIR, 'current', 'events.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toEqual(event1);
    expect(JSON.parse(lines[1] ?? '')).toEqual(event2);
  });

  it('creates directory when it does not exist', () => {
    const dir = makeTmp();
    const event: OrchestratorEvent = { ts: 1000, type: 'workflow_started', phase: 'idle', data: {} };
    appendEvent(dir, event);
    expect(existsSync(join(dir, TINY_SPEC_DIR, 'current', 'events.jsonl'))).toBe(true);
  });
});
