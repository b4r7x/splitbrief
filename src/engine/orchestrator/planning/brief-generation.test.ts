import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { BriefQualityReport } from '../../spec/brief-quality.js';
import { sha256Hex } from '../../../utils/sha256.js';
import {
  BRIEF_QUALITY_RULE_VERSION,
  briefQualityReportBytes,
} from '../../spec/brief-quality-file.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { taskId } from '../../../core/schemas/task.js';
import {
  BRIEF_GENERATION_STORAGE_POLICY,
  BriefGenerationManifestSchema,
  buildBriefGenerationIdentity,
  buildBriefSupportSnapshotIdentity,
  cleanupUnreferencedCandidates,
  installBriefGeneration,
  installBriefGenerationForTest,
  observeGenerationStorage,
  reserveGenerationStorage,
  storeBriefSupportSnapshot,
  verifyStoredGeneration,
  verifyStoredSupportSnapshot,
} from './brief-generation.js';
import { briefGenerationStorageError } from './immutable-store.js';
import type {
  BriefGenerationCandidate,
  BriefGenerationIdentity,
  BriefSupportSnapshotIdentity,
} from './brief-generation.js';

const quality: BriefQualityReport = { version: 1, passed: true, score: 1, issues: [] };

const blockedQuality: BriefQualityReport = {
  version: 1,
  passed: false,
  score: 0.8,
  issues: [
    {
      taskId: taskId('T001'),
      severity: 'error',
      code: 'missing_scope',
      message: 'Task T001 has no scope definition',
    },
  ],
};

function candidate(overrides: Partial<BriefGenerationCandidate> = {}): BriefGenerationCandidate {
  return {
    programId: 'program-a',
    parentGenerationId: null,
    batchReceiptDigests: ['batch-1', 'batch-2'],
    tasksText: '# Tasks\n\n## T001\n- action: create\n- file: src/a.ts\n- purpose: build a\n',
    qualityReport: quality,
    support: [
      { name: 'research.md', text: 'research bytes' },
      { name: 'spec.md', text: 'spec bytes' },
      { name: 'plan.md', text: 'plan bytes' },
    ],
    ...overrides,
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeExclusiveTestFile(filePath: string, text: string): void {
  const fd = openSync(filePath, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncTestDir(dirPath: string): void {
  const fd = openSync(dirPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function generationsDir(ref: SessionRef): string {
  return join(ref.projectDir, '.splitbrief', 'sessions', ref.sessionId, 'generations');
}

function supportDir(ref: SessionRef): string {
  return join(ref.projectDir, '.splitbrief', 'sessions', ref.sessionId, 'support-snapshots');
}

function installedFiles(ref: SessionRef, identity: BriefGenerationIdentity): string[] {
  return readdirSync(join(generationsDir(ref), identity.generationId)).sort();
}

function listOrEmpty(dirPath: string): string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function makeRef(): SessionRef {
  const projectDir = createTempDir('brief-generation-test');
  dirs.push(projectDir);
  return { projectDir, sessionId: 'session-1' };
}

function expectStorageError(action: () => void, isKind: (err: unknown) => boolean): void {
  let caught: unknown;
  try {
    action();
  } catch (err) {
    caught = err;
  }
  expect(isKind(caught)).toBe(true);
}

describe('brief generation identity', () => {
  it('is deterministic per candidate and sensitive to every artifact byte', () => {
    const first = buildBriefGenerationIdentity(candidate());
    const second = buildBriefGenerationIdentity(candidate());
    expect(second).toEqual(first);
    expect(buildBriefGenerationIdentity(candidate({ tasksText: 'changed' })).generationId).not.toBe(
      first.generationId,
    );
    expect(
      buildBriefGenerationIdentity(candidate({ qualityReport: blockedQuality })).generationId,
    ).not.toBe(first.generationId);
    expect(
      buildBriefGenerationIdentity(
        candidate({ support: [{ name: 'research.md', text: 'changed' }] }),
      ).generationId,
    ).not.toBe(first.generationId);
  });

  it('keeps the manifest free of its own digest and generationId', () => {
    const identity = buildBriefGenerationIdentity(candidate());
    const manifest = JSON.parse(identity.manifestBytes) as Record<string, unknown>;
    expect(manifest.generationId).toBeUndefined();
    expect(manifest.manifestDigest).toBeUndefined();
    expect(BriefGenerationManifestSchema.parse(manifest)).toEqual(manifest);
    expect(
      BriefGenerationManifestSchema.safeParse({ ...manifest, generationId: identity.generationId })
        .success,
    ).toBe(false);
    expect(
      BriefGenerationManifestSchema.safeParse({
        ...manifest,
        manifestDigest: identity.manifestDigest,
      }).success,
    ).toBe(false);
  });

  it('binds the generation ref to the manifest digests and program identity', () => {
    const identity = buildBriefGenerationIdentity(candidate());
    expect(identity.ref.generationId).toBe(identity.generationId);
    expect(identity.ref.manifestDigest).toBe(identity.manifestDigest);
    expect(identity.ref.tasksDigest).toBe(sha256Hex(candidate().tasksText));
    expect(identity.ref.qualityDigest).toBe(
      sha256Hex(briefQualityReportBytes({ issues: quality.issues })),
    );
    expect(identity.ref.programId).toBe('program-a');
  });

  it('rejects generations without a program that claim batch receipts', () => {
    const input = candidate({ programId: null, batchReceiptDigests: [] });
    expect(buildBriefGenerationIdentity(input).ref.programId).toBeNull();
    const manifest = JSON.parse(buildBriefGenerationIdentity(input).manifestBytes) as Record<
      string,
      unknown
    >;
    expect(
      BriefGenerationManifestSchema.safeParse({ ...manifest, batchReceiptDigests: ['batch-1'] })
        .success,
    ).toBe(false);
  });
});

describe('brief generation install and reuse', () => {
  it('installs an exclusive fsynced immutable generation with every artifact', () => {
    const ref = makeRef();
    const input = { ref, candidate: candidate() };
    const result = installBriefGeneration(input);
    expect(result.kind).toBe('installed');
    expect(installedFiles(ref, result.identity)).toEqual([
      'brief-quality.json',
      'manifest.json',
      'plan.md',
      'research.md',
      'spec.md',
      'tasks.md',
    ]);
    const generationDir = join(generationsDir(ref), result.identity.generationId);
    expect(readFileSync(join(generationDir, 'tasks.md'), 'utf8')).toBe(input.candidate.tasksText);
    expect(readFileSync(join(generationDir, 'research.md'), 'utf8')).toBe('research bytes');
    expect(JSON.parse(readFileSync(join(generationDir, 'brief-quality.json'), 'utf8'))).toEqual({
      ...quality,
      ruleVersion: BRIEF_QUALITY_RULE_VERSION,
    });
    expect(verifyStoredGeneration(ref, result.identity.generationId).ref).toEqual(
      result.identity.ref,
    );
    const manifest = JSON.parse(
      readFileSync(join(generationDir, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest.programId).toBe('program-a');
    expect(manifest.batchReceiptDigests).toEqual(['batch-1', 'batch-2']);
    expect(manifest.parentGenerationId).toBeNull();
  });

  it('reuses an existing generation after full byte verification instead of replacing it', () => {
    const ref = makeRef();
    const input = { ref, candidate: candidate() };
    const first = installBriefGeneration(input);
    const second = installBriefGeneration(input);
    expect(first.kind).toBe('installed');
    expect(second.kind).toBe('reused');
    expect(second.identity.generationId).toBe(first.identity.generationId);
    expect(readdirSync(generationsDir(ref))).toEqual([first.identity.generationId]);
  });

  it('keeps distinct candidates as distinct immutable generations', () => {
    const ref = makeRef();
    const first = installBriefGeneration({ ref, candidate: candidate() });
    const second = installBriefGeneration({
      ref,
      candidate: candidate({
        tasksText: '# Tasks\n\n## T002\n- action: modify\n- file: src/b.ts\n- purpose: build b\n',
      }),
    });
    expect(first.identity.generationId).not.toBe(second.identity.generationId);
    expect(readdirSync(generationsDir(ref)).sort()).toEqual(
      [first.identity.generationId, second.identity.generationId].sort(),
    );
  });
});

describe('brief generation install concurrency', () => {
  it('reclaims a stale install lock and proceeds', () => {
    const ref = makeRef();
    installBriefGeneration({ ref, candidate: candidate({ tasksText: 'seed' }) });
    writeFileSync(
      join(generationsDir(ref), '.install.lock'),
      JSON.stringify({ pid: 999_999_999, acquiredAt: Date.now() }),
    );
    const result = installBriefGeneration({ ref, candidate: candidate() });
    expect(result.kind).toBe('installed');
  });

  it('ignores and later cleans crashed-install candidate debris', () => {
    const ref = makeRef();
    const debris = join(generationsDir(ref), '.candidate-deadbeef');
    mkdirSync(debris, { recursive: true });
    writeFileSync(join(debris, 'tasks.md'), 'partial garbage');
    const result = installBriefGeneration({ ref, candidate: candidate() });
    expect(result.kind).toBe('installed');
    expect(verifyStoredGeneration(ref, result.identity.generationId).generationId).toBe(
      result.identity.generationId,
    );
    const cleanup = cleanupUnreferencedCandidates({ ref, referenced: [] });
    expect(cleanup.removedCandidateDirs).toEqual(['.candidate-deadbeef']);
    expect(readdirSync(generationsDir(ref))).toEqual([result.identity.generationId]);
  });
});

describe('brief generation mismatch detection', () => {
  it('refuses to reuse a generation whose stored bytes diverge from the manifest', () => {
    const ref = makeRef();
    const input = { ref, candidate: candidate() };
    const first = installBriefGeneration(input);
    const generationDir = join(generationsDir(ref), first.identity.generationId);
    writeFileSync(join(generationDir, 'tasks.md'), 'tampered tasks');
    expectStorageError(
      () => verifyStoredGeneration(ref, first.identity.generationId),
      briefGenerationStorageError.isMismatch,
    );
    expectStorageError(() => installBriefGeneration(input), briefGenerationStorageError.isMismatch);
    expect(readFileSync(join(generationDir, 'tasks.md'), 'utf8')).toBe('tampered tasks');
  });

  it('rejects foreign files inside a stored generation', () => {
    const ref = makeRef();
    const first = installBriefGeneration({ ref, candidate: candidate() });
    writeFileSync(join(generationsDir(ref), first.identity.generationId, 'sneaky.md'), 'extra');
    expectStorageError(
      () => verifyStoredGeneration(ref, first.identity.generationId),
      briefGenerationStorageError.isMismatch,
    );
  });

  it('rejects a tampered manifest identity', () => {
    const ref = makeRef();
    const first = installBriefGeneration({ ref, candidate: candidate() });
    const generationDir = join(generationsDir(ref), first.identity.generationId);
    const manifestPath = join(generationDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { programId: string };
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, programId: 'program-other' }));
    expectStorageError(
      () => verifyStoredGeneration(ref, first.identity.generationId),
      briefGenerationStorageError.isMismatch,
    );
  });
});

describe('brief generation install faults', () => {
  it('leaves no partial generation or candidate debris when a write fails midway', () => {
    const ref = makeRef();
    const prior = installBriefGeneration({ ref, candidate: candidate({ tasksText: 'prior' }) });
    expect(() =>
      installBriefGenerationForTest(
        { ref, candidate: candidate() },
        {
          writeArtifact: (filePath: string, text: string) => {
            if (filePath.endsWith('tasks.md')) throw new Error('disk fault');
            writeExclusiveTestFile(filePath, text);
          },
        },
      ),
    ).toThrow('disk fault');
    expect(readdirSync(generationsDir(ref)).sort()).toEqual([prior.identity.generationId]);
    expect(verifyStoredGeneration(ref, prior.identity.generationId).generationId).toBe(
      prior.identity.generationId,
    );
  });

  it('converges on retry when the directory fsync fails after the rename', () => {
    const ref = makeRef();
    const input = { ref, candidate: candidate() };
    let storeFsyncs = 0;
    expect(() =>
      installBriefGenerationForTest(input, {
        fsyncDir: (dirPath: string) => {
          if (dirPath === generationsDir(ref)) {
            storeFsyncs += 1;
            if (storeFsyncs === 1) throw new Error('dir fsync fault');
          }
          fsyncTestDir(dirPath);
        },
      }),
    ).toThrow('dir fsync fault');
    const retry = installBriefGeneration(input);
    expect(retry.kind).toBe('reused');
    expect(retry.identity.generationId).toBe(
      buildBriefGenerationIdentity(candidate()).generationId,
    );
  });
});

describe('brief generation quota bounds', () => {
  it('refuses an oversized candidate before writing anything', () => {
    const ref = makeRef();
    const oversized = candidate({
      tasksText: 'x'.repeat(BRIEF_GENERATION_STORAGE_POLICY.maxGenerationBytes + 1),
    });
    expectStorageError(
      () => installBriefGeneration({ ref, candidate: oversized }),
      briefGenerationStorageError.isOversized,
    );
    expect(listOrEmpty(generationsDir(ref))).toEqual([]);
    expectStorageError(
      () =>
        storeBriefSupportSnapshot({
          ref,
          snapshot: {
            programId: 'program-a',
            research: 'r',
            spec: 's',
            plan: 'x'.repeat(BRIEF_GENERATION_STORAGE_POLICY.maxGenerationBytes + 1),
          },
        }),
      briefGenerationStorageError.isOversized,
    );
    expect(listOrEmpty(supportDir(ref))).toEqual([]);
  });

  it('fails storage-safe when the full generation allowance cannot be reserved', () => {
    const ref = makeRef();
    for (let index = 0; index < 7; index += 1) {
      installBriefGeneration({
        ref,
        candidate: candidate({ tasksText: `gen-${index}` + 'x'.repeat(7 * 1024 * 1024) }),
      });
    }
    expectStorageError(() => reserveGenerationStorage(ref), briefGenerationStorageError.isQuota);
    const cleanup = cleanupUnreferencedCandidates({ ref, referenced: [] });
    expect(cleanup.retainedGenerations).toHaveLength(4);
    expect(() => reserveGenerationStorage(ref)).not.toThrow();
  });
});

describe('brief generation explicit-owner cleanup', () => {
  it('evicts verified unreferenced generations down to the count and byte bounds', () => {
    const ref = makeRef();
    const installed: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const result = installBriefGeneration({
        ref,
        candidate: candidate({ tasksText: `gen-${index}` + 'x'.repeat(7 * 1024 * 1024) }),
      });
      installed.push(result.identity.generationId);
      sleepSync(5);
    }
    const cleanup = cleanupUnreferencedCandidates({ ref, referenced: [] });
    expect(cleanup.evictedGenerationIds).toHaveLength(1);
    expect(installed).toContain(cleanup.evictedGenerationIds[0]);
    expect(cleanup.retainedGenerations.map((generation) => generation.generationId).sort()).toEqual(
      installed.filter((id) => id !== cleanup.evictedGenerationIds[0]).sort(),
    );
    const retainedBytes = cleanup.retainedGenerations.reduce(
      (total, generation) => total + generation.totalBytes,
      0,
    );
    expect(retainedBytes).toBeLessThanOrEqual(
      BRIEF_GENERATION_STORAGE_POLICY.maxUnreferencedGenerationBytes,
    );
    expect(cleanup.totalBytes).toBe(retainedBytes);
  });

  it('never evicts referenced generations or the current support snapshot', () => {
    const ref = makeRef();
    const oldest = installBriefGeneration({
      ref,
      candidate: candidate({ tasksText: 'oldest' + 'x'.repeat(7 * 1024 * 1024) }),
    });
    sleepSync(5);
    const unreferencedGenerationIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const result = installBriefGeneration({
        ref,
        candidate: candidate({ tasksText: `gen-${index}` + 'x'.repeat(7 * 1024 * 1024) }),
      });
      unreferencedGenerationIds.push(result.identity.generationId);
      sleepSync(5);
    }
    const unreferencedSupportIds: string[] = [];
    let currentSupport: Awaited<ReturnType<typeof storeBriefSupportSnapshot>> | null = null;
    for (let index = 0; index < 5; index += 1) {
      currentSupport = storeBriefSupportSnapshot({
        ref,
        snapshot: {
          programId: 'program-a',
          research: `r${index}`,
          spec: `s${index}`,
          plan: 'p'.repeat(3 * 1024 * 1024),
        },
      });
      if (index < 4) unreferencedSupportIds.push(currentSupport.identity.supportId);
      sleepSync(5);
    }
    if (currentSupport === null) throw new Error('support snapshots never installed');
    const cleanup = cleanupUnreferencedCandidates({
      ref,
      referenced: [oldest.identity.ref],
      currentSupportId: currentSupport.identity.supportId,
    });
    expect(cleanup.evictedGenerationIds).toHaveLength(2);
    expect(
      unreferencedGenerationIds.filter((id) => cleanup.evictedGenerationIds.includes(id)),
    ).toHaveLength(2);
    expect(cleanup.evictedGenerationIds).not.toContain(oldest.identity.generationId);
    expect(cleanup.retainedGenerations.map((generation) => generation.generationId).sort()).toEqual(
      [
        oldest.identity.generationId,
        ...unreferencedGenerationIds.filter((id) => !cleanup.evictedGenerationIds.includes(id)),
      ].sort(),
    );
    expect(cleanup.evictedSupportIds).toHaveLength(2);
    expect(
      unreferencedSupportIds.filter((id) => cleanup.evictedSupportIds.includes(id)),
    ).toHaveLength(2);
    expect(cleanup.evictedSupportIds).not.toContain(currentSupport.identity.supportId);
    expect(cleanup.retainedSupport.map((snapshot) => snapshot.supportId).sort()).toEqual(
      [
        currentSupport.identity.supportId,
        ...unreferencedSupportIds.filter((id) => !cleanup.evictedSupportIds.includes(id)),
      ].sort(),
    );
  });
});

describe('brief support snapshot store', () => {
  it('stores an immutable support snapshot with digest identity and reuses on repeat', () => {
    const ref = makeRef();
    const input = {
      ref,
      snapshot: { programId: 'program-a', research: 'research', spec: 'spec', plan: 'plan' },
    };
    const first = storeBriefSupportSnapshot(input);
    expect(first.kind).toBe('installed');
    const identity: BriefSupportSnapshotIdentity = buildBriefSupportSnapshotIdentity(
      input.snapshot,
    );
    expect(first.identity).toEqual(identity);
    const snapshotDirPath = join(supportDir(ref), first.identity.supportId);
    expect(readFileSync(join(snapshotDirPath, 'research.md'), 'utf8')).toBe('research');
    expect(verifyStoredSupportSnapshot(ref, first.identity.supportId).supportId).toBe(
      first.identity.supportId,
    );
    expect(first.identity.researchDigest).toBe(sha256Hex('research'));
    const second = storeBriefSupportSnapshot(input);
    expect(second.kind).toBe('reused');
    expect(readdirSync(supportDir(ref))).toEqual([first.identity.supportId]);
  });

  it('rejects a support snapshot whose stored bytes diverge', () => {
    const ref = makeRef();
    const first = storeBriefSupportSnapshot({
      ref,
      snapshot: { programId: 'program-a', research: 'research', spec: 'spec', plan: 'plan' },
    });
    writeFileSync(join(supportDir(ref), first.identity.supportId, 'plan.md'), 'tampered');
    expectStorageError(
      () => verifyStoredSupportSnapshot(ref, first.identity.supportId),
      briefGenerationStorageError.isMismatch,
    );
    expectStorageError(
      () =>
        storeBriefSupportSnapshot({
          ref,
          snapshot: { programId: 'program-a', research: 'research', spec: 'spec', plan: 'plan' },
        }),
      briefGenerationStorageError.isMismatch,
    );
  });
});

describe('generation storage observation', () => {
  it('reports totals and unverified entries without deleting anything', () => {
    const ref = makeRef();
    for (let index = 0; index < 7; index += 1) {
      installBriefGeneration({
        ref,
        candidate: candidate({ tasksText: `gen-${index}` + 'x'.repeat(7 * 1024 * 1024) }),
      });
    }
    storeBriefSupportSnapshot({
      ref,
      snapshot: { programId: 'p', research: 'r', spec: 's', plan: 'p' },
    });
    const debris = join(generationsDir(ref), '.candidate-0123abcd');
    mkdirSync(debris, { recursive: true });
    writeFileSync(join(debris, 'tasks.md'), 'partial');
    const before = readdirSync(generationsDir(ref)).sort();
    const beforeSupport = readdirSync(supportDir(ref)).sort();

    const observation = observeGenerationStorage(ref);
    expect(observation.generations).toHaveLength(7);
    expect(observation.support).toHaveLength(1);
    expect(observation.candidateDirs).toEqual(['.candidate-0123abcd']);
    expect(observation.unverifiedGenerationIds).toEqual([]);
    expect(observation.totalBytes).toBeGreaterThan(BRIEF_GENERATION_STORAGE_POLICY.maxTotalBytes);

    expect(readdirSync(generationsDir(ref)).sort()).toEqual(before);
    expect(readdirSync(supportDir(ref)).sort()).toEqual(beforeSupport);
    expectStorageError(() => reserveGenerationStorage(ref), briefGenerationStorageError.isQuota);
    expect(readdirSync(generationsDir(ref)).sort()).toEqual(before);
    expect(readdirSync(supportDir(ref)).sort()).toEqual(beforeSupport);

    const cleanup = cleanupUnreferencedCandidates({ ref, referenced: [] });
    expect(cleanup.removedCandidateDirs).toEqual(['.candidate-0123abcd']);
    expect(cleanup.retainedGenerations).toHaveLength(4);
  });

  it('reports corrupted generations as unverified without evicting them', () => {
    const ref = makeRef();
    const first = installBriefGeneration({ ref, candidate: candidate() });
    writeFileSync(join(generationsDir(ref), first.identity.generationId, 'tasks.md'), 'tampered');
    const observation = observeGenerationStorage(ref);
    expect(observation.generations).toHaveLength(0);
    expect(observation.unverifiedGenerationIds).toEqual([first.identity.generationId]);
    const cleanup = cleanupUnreferencedCandidates({ ref, referenced: [] });
    expect(cleanup.evictedGenerationIds).toEqual([]);
    expect(readdirSync(generationsDir(ref))).toEqual([first.identity.generationId]);
  });

  it('never classifies the install lock file as a store entry', () => {
    const ref = makeRef();
    const first = installBriefGeneration({ ref, candidate: candidate() });
    const baseline = observeGenerationStorage(ref).totalBytes;
    writeFileSync(
      join(generationsDir(ref), '.install.lock'),
      JSON.stringify({ pid: 999_999_999, acquiredAt: Date.now() }),
    );
    const observation = observeGenerationStorage(ref);
    expect(observation.unverifiedGenerationIds).toEqual([]);
    expect(observation.totalBytes).toBe(baseline);
    const cleanup = cleanupUnreferencedCandidates({ ref, referenced: [] });
    expect(cleanup.evictedGenerationIds).toEqual([]);
    expect(readdirSync(generationsDir(ref)).sort()).toEqual(
      ['.install.lock', first.identity.generationId].sort(),
    );
  });
});

describe('brief generation storage fault-injection helpers', () => {
  it('supports injected rename faults that leave the store unchanged', () => {
    const ref = makeRef();
    expect(() =>
      installBriefGenerationForTest(
        { ref, candidate: candidate() },
        {
          renameCandidate: () => {
            throw new Error('rename fault');
          },
        },
      ),
    ).toThrow('rename fault');
    expect(readdirSync(generationsDir(ref))).toEqual([]);
    const retry = installBriefGeneration({ ref, candidate: candidate() });
    expect(retry.kind).toBe('installed');
  });
});
