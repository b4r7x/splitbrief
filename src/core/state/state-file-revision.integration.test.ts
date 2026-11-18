import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeState, setupProject } from '#testing/helpers/state-ops.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { commitWorkflowState } from '../../engine/orchestrator/state-ops/commit.js';
import { readStateHead } from '../../engine/orchestrator/state-ops/head.js';
import { readRawState, serializedState, statePath } from './file.js';
import { loadState, saveState } from './persistence.js';

const boundary = vi.hoisted((): { beforeBytes?: () => void } => ({}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync(...args: Parameters<typeof fs.readFileSync>) {
      const [path] = args;
      if (typeof path === 'number' && boundary.beforeBytes !== undefined) {
        const beforeBytes = boundary.beforeBytes;
        delete boundary.beforeBytes;
        beforeBytes();
      }
      return fs.readFileSync(...args);
    },
  };
});

const tick = 1_700_000_000;
let ref: ReturnType<typeof setupProject>;

beforeEach(() => {
  ref = setupProject();
});

afterEach(() => {
  delete boundary.beforeBytes;
  cleanupTempDir(ref.projectDir);
});

it.each(['head', 'raw', 'commit', 'save'] as const)(
  'completed same-inode write before reading any bytes: %s',
  (operation) => {
    const path = statePath(ref);
    const state = makeState({ stateRevision: 16 });
    writeFileSync(path, serializedState(state), { mode: 0o600 });
    utimesSync(path, tick, tick);
    const updated = { ...state, feature: 'longer feature name' };
    const rewritten = serializedState(updated);
    const fileIdentity = {
      size: BigInt(rewritten.length),
      mtimeNs: BigInt(tick + 1) * 1_000_000_000n,
    };
    boundary.beforeBytes = () => {
      writeFileSync(path, rewritten);
      utimesSync(path, tick + 1, tick + 1);
    };

    if (operation === 'head') {
      expect(readStateHead(ref)?.revision.fileIdentity).toMatchObject(fileIdentity);
    } else if (operation === 'raw') {
      expect(readRawState(ref)).toMatchObject({
        kind: 'present',
        raw: { revision: { fileIdentity } },
      });
    } else if (operation === 'commit') {
      expect(commitWorkflowState({ ref, expected: updated, next: updated }).kind).toBe('committed');
    } else {
      saveState(ref, { ...updated, feature: 'saved by caller' });
      expect(JSON.parse(readFileSync(path, 'utf8')).feature).toBe('saved by caller');
    }
  },
);

it('a cache hit must match a full revision that existed during this read', () => {
  const path = statePath(ref);
  const state = makeState({ stateRevision: 16 });
  const original = serializedState(state);
  writeFileSync(path, original);
  utimesSync(path, tick, tick);
  const cached = loadState(ref);
  expect(cached?.stateRevision).toBe(16);
  const before = statSync(path, { bigint: true });

  const different = serializedState({ ...state, stateRevision: 17 });
  expect(different.length).toBe(original.length);
  writeFileSync(path, different);
  utimesSync(path, tick, tick);
  expect(JSON.parse(readFileSync(path, 'utf8')).stateRevision).toBe(17);
  boundary.beforeBytes = () => {
    // Change the mtime before restoring the bytes so the cached revision never recurs.
    utimesSync(path, tick + 1, tick + 1);
    writeFileSync(path, original);
    utimesSync(path, tick + 2, tick + 2);
  };

  const loaded = loadState(ref);
  expect(statSync(path, { bigint: true }).mtimeNs).not.toBe(before.mtimeNs);
  expect(loaded?.stateRevision).toBe(16);
  expect(loaded).not.toBe(cached);
});
