import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveState, loadState, appendEvent, appendMessage } from './persistence.js';
import { createInitialState } from './machine.js';
import { taskId } from '../types/workflow.js';
import type { OrchestratorEvent } from '../types/index.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from '../paths.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});

let tmp: string;
const SESSION_ID = '2024-01-01-test-feature';

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
    saveState(dir, SESSION_ID, state);
    const loaded = loadState(dir, SESSION_ID);
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
    saveState(dir, SESSION_ID, state);
    const loaded = loadState(dir, SESSION_ID);
    expect(loaded).not.toBeNull();
    expect(loaded!.plannerTool).toBe('openrouter');
    expect(loaded!.plannerModel).toBe('claude-sonnet-4-20250514');
    expect(loaded!.implementerTool).toBe('ollama');
    expect(loaded!.implementerModel).toBe('qwen2.5-coder:14b');
  });

  it('creates session directory when it does not exist', () => {
    const dir = makeTmp();
    const nested = join(dir, 'deep', 'nested');
    expect(existsSync(nested)).toBe(false);
    saveState(nested, SESSION_ID, createInitialState('feat'));
    expect(existsSync(join(nested, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'state.json'))).toBe(true);
  });
});

describe('loadState', () => {
  it('returns null when file does not exist', () => {
    const dir = makeTmp();
    expect(loadState(dir, SESSION_ID)).toBeNull();
  });

  it('returns null when state is malformed (missing phase)', () => {
    const dir = makeTmp();
    const stateDir = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ stateVersion: 2, tasks: [] }));
    expect(loadState(dir, SESSION_ID)).toBeNull();
  });

  it('returns null when state is malformed (tasks not an array)', () => {
    const dir = makeTmp();
    const stateDir = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ stateVersion: 2, phase: 'idle', tasks: 'not-array' }));
    expect(loadState(dir, SESSION_ID)).toBeNull();
  });

  it('returns null when state file contains invalid JSON', () => {
    const dir = makeTmp();
    const stateDir = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), '{not valid json!!!');
    expect(loadState(dir, SESSION_ID)).toBeNull();
  });
});

describe('appendEvent', () => {
  it('appends JSONL lines to session log file with kind:event and ISO ts', () => {
    const dir = makeTmp();
    const event1: OrchestratorEvent = { ts: 1000, type: 'task_started', taskId: taskId('T001'), phase: 'implementing', data: {} };
    const event2: OrchestratorEvent = { ts: 2000, type: 'task_completed', taskId: taskId('T001'), phase: 'implementing', data: { method: 'local' } };

    appendEvent(dir, SESSION_ID, event1);
    appendEvent(dir, SESSION_ID, event2);

    const raw = readFileSync(join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    const entry1 = JSON.parse(lines[0] ?? '');
    const entry2 = JSON.parse(lines[1] ?? '');
    expect(entry1.kind).toBe('event');
    expect(entry1.ts).toBe(new Date(1000).toISOString());
    expect(entry1.type).toBe('task_started');
    expect(entry2.kind).toBe('event');
    expect(entry2.ts).toBe(new Date(2000).toISOString());
    expect(entry2.type).toBe('task_completed');
  });

  it('creates directory when it does not exist', () => {
    const dir = makeTmp();
    const event: OrchestratorEvent = { ts: 1000, type: 'workflow_started', phase: 'idle', data: {} };
    appendEvent(dir, SESSION_ID, event);
    expect(existsSync(join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'))).toBe(true);
  });

  describe('failure handling', () => {
    beforeEach(() => { vi.mocked(appendFileSync).mockClear(); });
    afterEach(() => { vi.mocked(appendFileSync).mockRestore(); });

    it('warns to stderr and does not throw when write fails', () => {
      vi.mocked(appendFileSync).mockImplementationOnce(() => { throw new Error('disk full'); });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const dir = makeTmp();
        const event: OrchestratorEvent = { ts: 1000, type: 'workflow_started', phase: 'idle', data: {} };
        expect(() => appendEvent(dir, SESSION_ID, event)).not.toThrow();
        const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(output).toContain('disk full');
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});

describe('appendMessage', () => {
  it('writes kind:message entry with ISO ts when persistTranscript is true', () => {
    const dir = makeTmp();
    appendMessage(dir, SESSION_ID, { role: 'user', text: 'add auth' }, true);
    const raw = readFileSync(join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'), 'utf-8');
    const entry = JSON.parse(raw.trim());
    expect(entry.kind).toBe('message');
    expect(entry.role).toBe('user');
    expect(entry.text).toBe('add auth');
    expect(typeof entry.ts).toBe('string');
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not write anything when persistTranscript is false', () => {
    const dir = makeTmp();
    appendMessage(dir, SESSION_ID, { role: 'assistant', text: 'planner output' }, false);
    const filePath = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl');
    expect(existsSync(filePath)).toBe(false);
  });

  it('includes optional fields when provided', () => {
    const dir = makeTmp();
    appendMessage(dir, SESSION_ID, { role: 'assistant', phase: 'researching', text: 'hello', interrupted: true }, true);
    const raw = readFileSync(join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'), 'utf-8');
    const entry = JSON.parse(raw.trim());
    expect(entry.phase).toBe('researching');
    expect(entry.interrupted).toBe(true);
  });
});
