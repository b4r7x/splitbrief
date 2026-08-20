import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSessionDir } from '../paths-io.js';
import { sessionDir, stateAuthorityDirectory, STATE_FILE } from '../paths.js';
import { createInitialState } from './machine.js';
import { saveState } from './persistence.js';
import {
  acquireStateAuthority,
  assertStateAuthority,
  readStateAuthority,
  releaseStateAuthority,
} from './authority.js';
import type { SessionRef } from '../types/session-ref.js';

type Fixture = Readonly<{ projectDir: string; ref: SessionRef }>;

const fixtures: string[] = [];

function fixture(): Fixture {
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'splitbrief-authority-')));
  const ref = { projectDir, sessionId: 'session-1' };
  ensureSessionDir(projectDir, ref.sessionId);
  fixtures.push(projectDir);
  return { projectDir, ref };
}

afterEach(() => {
  for (const projectDir of fixtures.splice(0)) rmSync(projectDir, { recursive: true, force: true });
});

describe('session state authority', () => {
  it('publishes a synced usable receipt only after the state fence commit', () => {
    const { ref } = fixture();
    saveState(ref, createInitialState('authority'));

    const result = acquireStateAuthority({
      ref,
      purpose: 'resume',
      ownerId: 'owner-1',
      runId: 'run-1',
      acquisitionId: 'acquisition-1',
    });

    expect(result.kind).toBe('fenced');
    if (result.kind !== 'fenced') return;
    const directoryMode = statSync(stateAuthorityDirectory(ref)).mode & 0o777;
    const recordMode = statSync(join(stateAuthorityDirectory(ref), 'owner.json')).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(recordMode).toBe(0o600);
    expect(readStateAuthority(ref)).toEqual(result.receipt);
    expect(() => assertStateAuthority({ ref, receipt: result.receipt })).not.toThrow();
    expect(releaseStateAuthority(ref, result.receipt)).toBe(true);
  });

  it('returns a candidate only for a missing new workflow and a permit for resume', () => {
    const { ref } = fixture();
    const resume = acquireStateAuthority({ ref, purpose: 'resume', acquisitionId: 'resume-1' });
    expect(resume.kind).toBe('read-only');
    expect(readStateAuthority(ref)).toBeNull();

    const newWorkflow = acquireStateAuthority({
      ref,
      purpose: 'new-workflow',
      acquisitionId: 'new-1',
    });
    expect(newWorkflow.kind).toBe('new-workflow');
    expect(statSync(stateAuthorityDirectory(ref)).isDirectory()).toBe(true);
  });

  it('requires a dead process identity for takeover and fences the successor', () => {
    const { ref } = fixture();
    saveState(ref, createInitialState('authority'));
    const old = acquireStateAuthority({
      ref,
      purpose: 'resume',
      ownerId: 'old-owner',
      runId: 'old-run',
      acquisitionId: 'old-acquisition',
      pid: 2_147_483_646,
      processStart: '1',
    });
    expect(old.kind).toBe('fenced');
    if (old.kind !== 'fenced') return;

    const successor = acquireStateAuthority({
      ref,
      purpose: 'resume',
      ownerId: 'new-owner',
      runId: 'new-run',
      acquisitionId: 'new-acquisition',
    });
    expect(successor.kind).toBe('fenced');
    if (successor.kind !== 'fenced') return;
    expect(releaseStateAuthority(ref, old.receipt)).toBe(false);
    expect(readStateAuthority(ref)).toEqual(successor.receipt);
    expect(releaseStateAuthority(ref, successor.receipt)).toBe(true);
  });

  it('does not rewrite a malformed or future state head', () => {
    const { ref } = fixture();
    const path = join(sessionDir(ref.projectDir, ref.sessionId), STATE_FILE);
    const raw = '{"stateVersion":99,"future":true}\n';
    writeFileSync(path, raw, { mode: 0o600 });

    const result = acquireStateAuthority({ ref, purpose: 'resume', acquisitionId: 'future-1' });

    expect(result.kind).toBe('read-only');
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });
});
