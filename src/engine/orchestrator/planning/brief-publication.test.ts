import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSessionDir, readSpecFile } from '../../../core/paths-io.js';
import { BRIEF_QUALITY_FILE, TASKS_FILE, sessionDir } from '../../../core/paths.js';
import type { EventBus } from '../../events/types.js';
import {
  BriefOwnerEventSchema,
  type BriefOwnerCommitInput,
  type BriefOwnerCommitPort,
  type BriefOwnerExpected,
} from '../../../core/schemas/brief-owner.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeBusRecorder, TEST_METADATA } from '#testing/helpers/orchestrator-factories.js';
import { REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { makeTestOwnerCommit } from '#testing/helpers/brief-owner.js';
import { evaluateBriefQuality } from '../../spec/brief-quality.js';
import { briefQualityReportBytes } from '../../spec/brief-quality-file.js';
import { parseTasksStrict } from '../../spec/tasks/parse.js';
import { taskId } from '../../../core/schemas/task.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { sha256Hex } from '../../../utils/sha256.js';
import {
  observeGenerationStorage,
  verifyStoredGeneration,
  type BriefGenerationCandidate,
} from './brief-generation.js';
import { publishBriefGeneration, type BriefPublicationOptions } from './brief-publication.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

const EXPECTED: BriefOwnerExpected = {
  epochId: 'epoch-1',
  stateRevision: {
    rawSha256: 'a'.repeat(64),
    fileIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
  },
  authorityRevision: 0,
  fence: '1',
  evidenceHead: null,
};

function ref(projectDir: string): SessionRef {
  return { projectDir, sessionId: 'sess-publication' };
}

function setup(): {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  events: Array<{ type: string }>;
} {
  const projectDir = createTempDir('brief-publication');
  dirs.push(projectDir);
  ensureSessionDir(projectDir, 'sess-publication');
  const { bus, events } = makeBusRecorder();
  return { projectDir, sessionId: 'sess-publication', bus, events };
}

function candidate(overrides: Partial<BriefGenerationCandidate> = {}): BriefGenerationCandidate {
  const tasksText = REAL_TASKS_MD;
  const tasks = parseTasksStrict(tasksText);
  return {
    programId: 'program-1',
    parentGenerationId: null,
    batchReceiptDigests: [],
    tasksText,
    qualityReport: evaluateBriefQuality(tasks),
    support: [
      { name: 'research.md', text: '# Research\n' },
      { name: 'spec.md', text: '# Spec\n' },
      { name: 'plan.md', text: '# Plan\n' },
    ],
    ...overrides,
  };
}

function optionsFor(
  r: SessionRef,
  commit: BriefOwnerCommitPort,
  bus: EventBus,
  overrides: Partial<BriefPublicationOptions> = {},
): BriefPublicationOptions {
  return {
    ref: r,
    candidate: candidate(),
    expected: EXPECTED,
    operationId: 'op-publication',
    eventId: 'publication-1',
    recoveryRevision: 0,
    phase: 'reviewing-briefs',
    ts: 1_752_000_000_000,
    commit,
    bus,
    metadata: TEST_METADATA,
    ...overrides,
  };
}

function recordingCommit(): { commit: BriefOwnerCommitPort; inputs: BriefOwnerCommitInput[] } {
  const inputs: BriefOwnerCommitInput[] = [];
  return {
    inputs,
    commit: (input) => {
      inputs.push(input);
      return {
        kind: 'conflict',
        stateRevision: null,
        authorityRevision: null,
        recovery: null,
        generation: null,
        permit: null,
      };
    },
  };
}

describe('publishBriefGeneration — evaluation before publication', () => {
  it('returns a typed parse fault for malformed candidate text with zero side effects', () => {
    const { projectDir, bus, events } = setup();
    const r = ref(projectDir);
    const { inputs, commit } = recordingCommit();

    const result = publishBriefGeneration(
      optionsFor(r, commit, bus, {
        candidate: candidate({
          tasksText: '---\nid: T001\n---\n### Description\nmalformed task block\n',
        }),
      }),
    );

    expect(result).toEqual({ ok: false, fault: 'parse', message: expect.any(String) });
    expect(inputs).toHaveLength(0);
    expect(observeGenerationStorage(r).generations).toHaveLength(0);
    expect(observeGenerationStorage(r).support).toHaveLength(0);
    expect(readSpecFile(r, TASKS_FILE)).toBeNull();
    expect(() =>
      readFileSync(join(sessionDir(r.projectDir, r.sessionId), BRIEF_QUALITY_FILE), 'utf8'),
    ).toThrow();
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'brief_generation_published')).toHaveLength(0);
  });

  it('never publishes a candidate with no Tasks', () => {
    const { projectDir, bus, events } = setup();
    const r = ref(projectDir);
    const { inputs, commit } = recordingCommit();

    const result = publishBriefGeneration(
      optionsFor(r, commit, bus, { candidate: candidate({ tasksText: '' }) }),
    );

    expect(result).toEqual({ ok: false, fault: 'parse', message: expect.any(String) });
    expect(inputs).toHaveLength(0);
    expect(observeGenerationStorage(r).generations).toHaveLength(0);
    expect(readSpecFile(r, TASKS_FILE)).toBeNull();
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });

  it('returns a typed quality fault and parks the support snapshot before any commit', () => {
    const { projectDir, bus, events } = setup();
    const r = ref(projectDir);
    const { inputs, commit } = recordingCommit();

    const result = publishBriefGeneration(
      optionsFor(r, commit, bus, {
        candidate: candidate({
          qualityReport: {
            version: 1,
            passed: false,
            score: 0.8,
            issues: [
              {
                code: 'missing_scope',
                severity: 'error',
                taskId: taskId('T001'),
                message: 'scope is missing',
              },
            ],
          },
        }),
      }),
    );

    expect(result).toEqual({
      ok: false,
      fault: 'quality',
      report: expect.objectContaining({ passed: false, score: 0.8 }),
      message: expect.any(String),
    });
    expect(inputs).toHaveLength(0);
    expect(observeGenerationStorage(r).generations).toHaveLength(0);
    expect(observeGenerationStorage(r).support).toHaveLength(1);
    expect(readSpecFile(r, TASKS_FILE)).toBeNull();
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'brief_generation_published')).toHaveLength(0);
  });
});

describe('publishBriefGeneration — storage, event, and CAS faults', () => {
  it('returns a typed storage fault when the candidate exceeds the generation ceiling', () => {
    const { projectDir, bus, events } = setup();
    const r = ref(projectDir);
    const { inputs, commit } = recordingCommit();

    const result = publishBriefGeneration(
      optionsFor(r, commit, bus, {
        candidate: candidate({
          support: [
            { name: 'research.md', text: 'x'.repeat(8 * 1024 * 1024 + 1) },
            { name: 'spec.md', text: '# Spec\n' },
            { name: 'plan.md', text: '# Plan\n' },
          ],
        }),
      }),
    );

    expect(result).toEqual({ ok: false, fault: 'storage', message: expect.any(String) });
    expect(inputs).toHaveLength(0);
    expect(readSpecFile(r, TASKS_FILE)).toBeNull();
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });

  it('returns a typed event fault for an invalid publication event and leaves only an unreferenced generation', () => {
    const { projectDir, bus, events } = setup();
    const r = ref(projectDir);
    const { inputs, commit } = recordingCommit();

    const result = publishBriefGeneration(optionsFor(r, commit, bus, { eventId: 'bad event id' }));

    expect(result).toEqual({ ok: false, fault: 'event', message: expect.any(String) });
    expect(inputs).toHaveLength(0);
    expect(observeGenerationStorage(r).generations).toHaveLength(1);
    expect(readSpecFile(r, TASKS_FILE)).toBeNull();
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });

  it('returns a typed event fault when the owner commit throws and never projects', () => {
    const { projectDir, bus, events } = setup();
    const r = ref(projectDir);
    const commit: BriefOwnerCommitPort = () => {
      throw new Error('owner commit crashed');
    };

    const result = publishBriefGeneration(optionsFor(r, commit, bus));

    expect(result).toEqual({ ok: false, fault: 'event', message: expect.any(String) });
    expect(readSpecFile(r, TASKS_FILE)).toBeNull();
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });

  it('returns a typed CAS fault on a stale owner commit and never projects', () => {
    const { projectDir, bus, events } = setup();
    const r = ref(projectDir);
    const { inputs, commit } = recordingCommit();

    const result = publishBriefGeneration(optionsFor(r, commit, bus));

    expect(result).toEqual({ ok: false, fault: 'cas', message: expect.any(String) });
    expect(inputs).toHaveLength(1);
    expect(readSpecFile(r, TASKS_FILE)).toBeNull();
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });
});

describe('publishBriefGeneration — matching-digest success', () => {
  it('commits the installed generation with matching digests and projects only afterward', () => {
    const { projectDir, sessionId, bus, events } = setup();
    const r = ref(projectDir);
    let tasksAtCommit: string | null = 'unset';
    let capturedEvent: unknown;
    const owner = makeTestOwnerCommit({
      onCommit: () => {
        tasksAtCommit = readSpecFile(r, TASKS_FILE);
      },
    });
    const commit: BriefOwnerCommitPort = (input) => {
      capturedEvent = input.event;
      return owner(input);
    };

    const result = publishBriefGeneration(optionsFor(r, commit, bus));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.committed.generation).toEqual(result.identity.ref);
    expect(result.committed.permit).toBeNull();
    expect(result.committed.authorityRevision).toBe(EXPECTED.authorityRevision + 1);

    const stored = verifyStoredGeneration(r, result.identity.generationId);
    expect(stored.ref).toEqual(result.identity.ref);
    expect(stored.ref.tasksDigest).toBe(sha256Hex(REAL_TASKS_MD));
    expect(stored.ref.qualityDigest).toBe(
      sha256Hex(briefQualityReportBytes({ issues: candidate().qualityReport.issues })),
    );

    const event = BriefOwnerEventSchema.parse(capturedEvent);
    expect(event.type).toBe('brief_generation_published');
    if (event.type !== 'brief_generation_published') {
      throw new Error('expected a generation-published event');
    }
    expect(event.generation).toEqual(result.identity.ref);
    expect(event.epochId).toBe(EXPECTED.epochId);
    expect(event.provenanceDigest).toBe(
      sha256Hex(
        canonicalJSON({
          programId: 'program-1',
          parentGenerationId: null,
          batchReceiptDigests: [],
        }),
      ),
    );

    expect(tasksAtCommit).toBeNull();
    const projected = readSpecFile(r, TASKS_FILE);
    expect(projected).not.toBeNull();
    if (projected === null) return;
    expect(parseTasksStrict(projected)).toEqual(parseTasksStrict(REAL_TASKS_MD));
    expect(readFileSync(join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE), 'utf8')).toBe(
      briefQualityReportBytes({ issues: candidate().qualityReport.issues }),
    );

    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'brief_generation_published')).toHaveLength(0);
  });
});
