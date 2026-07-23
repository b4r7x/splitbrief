import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  driftChainsPath,
  emptyActiveChain,
  initialDriftChainState,
  readDriftChainState,
  writeDriftChainState,
} from './chain-state.js';

describe('initialDriftChainState', () => {
  it('returns version 1 and empty active chain', () => {
    const state = initialDriftChainState('sess-1');
    expect(state.version).toBe(1);
    expect(state.sessionId).toBe('sess-1');
    expect(state.activeChain.entries).toEqual([]);
    expect(state.activeChain.uniqueFiles).toEqual([]);
    expect(state.activeChain.score).toBe(0);
    expect(state.emittedChains).toEqual([]);
  });
});

describe('driftChainsPath', () => {
  it('returns expected path under .diptych/sessions/<id>/drift-chains.json', () => {
    const path = driftChainsPath({ projectDir: '/project', sessionId: 'sess-abc' });
    expect(path).toBe('/project/.diptych/sessions/sess-abc/drift-chains.json');
  });
});

describe('readDriftChainState', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drift-chain-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when file is absent', () => {
    expect(readDriftChainState({ projectDir: dir, sessionId: 'missing' })).toBeNull();
  });

  it('returns null when file contains invalid JSON', () => {
    const sessionPath = join(dir, '.diptych', 'sessions', 's1');
    mkdirSync(sessionPath, { recursive: true });
    writeFileSync(driftChainsPath({ projectDir: dir, sessionId: 's1' }), '{not valid json');
    expect(readDriftChainState({ projectDir: dir, sessionId: 's1' })).toBeNull();
  });

  it('returns null when file contains JSON that fails schema validation', () => {
    const sessionPath = join(dir, '.diptych', 'sessions', 's1');
    mkdirSync(sessionPath, { recursive: true });
    writeFileSync(
      driftChainsPath({ projectDir: dir, sessionId: 's1' }),
      JSON.stringify({ version: 99, bad: true }),
    );
    expect(readDriftChainState({ projectDir: dir, sessionId: 's1' })).toBeNull();
  });
});

describe('writeDriftChainState', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drift-chain-write-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a newline-terminated state and reads it back', () => {
    const state = initialDriftChainState('s2');
    writeDriftChainState({ projectDir: dir, sessionId: 's2' }, state);
    const path = driftChainsPath({ projectDir: dir, sessionId: 's2' });
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw).version).toBe(1);

    const result = readDriftChainState({ projectDir: dir, sessionId: 's2' });
    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
    expect(result?.sessionId).toBe('s2');
    expect(result?.activeChain).toEqual(emptyActiveChain());
    expect(result?.emittedChains).toEqual([]);
  });
});
