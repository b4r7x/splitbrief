import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { commitWorkflowState } from '../../engine/orchestrator/state-ops/commit.js';
import { statePath } from './file.js';
import { createInitialState } from './machine.js';
import { loadState, saveState } from './persistence.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const tick = 1_700_000_000;
let projectDir: string;

afterEach(() => cleanupTempDir(projectDir));

it.each(['atomic replacement', 'in-place edit'] as const)(
  'loads the current revision after an equal-length %s at the same mtime',
  (publication) => {
    projectDir = createTempDir('same-tick-state');
    const ref = { projectDir, sessionId: 'same-tick-state' };
    const first = { ...createInitialState('test brief'), stateRevision: 16 };
    saveState(ref, first);
    const path = statePath(ref);
    utimesSync(path, tick, tick);
    const previous = statSync(path, { bigint: true });
    expect(loadState(ref)?.stateRevision).toBe(16);

    if (publication === 'atomic replacement') {
      expect(commitWorkflowState({ ref, expected: first, next: first }).kind).toBe('committed');
    } else {
      const bytes = readFileSync(path, 'utf8');
      writeFileSync(path, bytes.replace('"stateRevision": 16', '"stateRevision": 17'));
    }
    utimesSync(path, tick, tick);
    const current = statSync(path, { bigint: true });
    expect(current.size).toBe(previous.size);
    expect(current.mtimeNs).toBe(previous.mtimeNs);
    expect(current.dev).toBe(previous.dev);
    expect(current.ino === previous.ino).toBe(publication === 'in-place edit');
    expect(JSON.parse(readFileSync(path, 'utf8')).stateRevision).toBe(17);
    expect(loadState(ref)?.stateRevision).toBe(17);
  },
);
