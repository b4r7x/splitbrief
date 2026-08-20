import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { readSpecFile, writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import { PLAN_FILE, RESEARCH_FILE, SPEC_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
} from '#testing/helpers/orchestrator-task-context.js';
import {
  writeAndPublishArtifact,
  writeAndPublishArtifacts,
  type ArtifactKind,
} from './artifact-write.js';
import { createInitialState } from '../../core/state/machine.js';
import { createBriefRecoveryState } from './planning/brief-recovery.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { resolveOwnerReadiness } from './planning/io.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { BriefGenerationRef, TaskExecutionPermit } from '../../core/schemas/brief-owner.js';
import { sha256Hex } from '../../utils/sha256.js';

const SESSION_ID = 'artifact-write-test';
const METADATA: SpecMetadata = {
  plannerTool: 'claude-code',
  plannerModel: 'opus',
  implementerTool: 'codex',
  implementerModel: 'gpt-5',
  mode: 'standard',
};

const GENERATION: BriefGenerationRef = {
  generationId: 'generation-owner-a1b2c3d4e5f60718',
  manifestDigest: sha256Hex('manifest'),
  tasksDigest: sha256Hex('tasks'),
  qualityDigest: sha256Hex('quality'),
  programId: null,
};

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir !== undefined) cleanupTempDir(tempDir);
  tempDir = undefined;
  cleanupTaskProjects();
});

function fixtureDir(): string {
  tempDir = createTempDir('artifact-write-test');
  return tempDir;
}

function writeOptions(
  projectDir: string,
  kind: ArtifactKind,
  text: string,
  metadata: SpecMetadata | null | undefined,
) {
  return {
    projectDir,
    sessionId: SESSION_ID,
    bus: makeBusRecorder().bus,
    phase: kind === 'spec' ? ('specifying' as const) : ('planning' as const),
    kind,
    text,
    metadata,
  };
}

describe('writeAndPublishArtifact', () => {
  it.each([
    { kind: 'spec' as const, filename: SPEC_FILE, phase: 'specifying' as const },
    { kind: 'plan' as const, filename: PLAN_FILE, phase: 'planning' as const },
  ])(
    'rejects an invalid $kind replacement before changing bytes or publishing',
    ({ kind, filename, phase }) => {
      const projectDir = fixtureDir();
      const previous = `${filename} approved bytes\r\n\u0000\u0001`;
      writeSpecFile({ projectDir, sessionId: SESSION_ID }, filename, previous, null);
      const path = join(sessionDir(projectDir, SESSION_ID), filename);
      const before = readFileSync(path);
      const { bus, events } = makeBusRecorder();

      expect(() =>
        writeAndPublishArtifact({
          ...writeOptions(projectDir, kind, 'planner prose without a heading', null),
          bus,
          phase,
        }),
      ).toThrowError(
        expect.objectContaining({
          kind: 'planning-invalid-artifact',
          data: { phase, filename, missingShape: 'Markdown heading' },
        }),
      );

      expect(readFileSync(path)).toEqual(before);
      expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
    },
  );

  it.each([
    {
      kind: 'spec' as const,
      filename: SPEC_FILE,
      phase: 'specifying' as const,
      text: '# Spec\n\nAccepted.',
    },
    {
      kind: 'plan' as const,
      filename: PLAN_FILE,
      phase: 'planning' as const,
      text: '# Plan\n\nAccepted.',
    },
  ])('writes and publishes an admitted $kind exactly once', ({ kind, filename, phase, text }) => {
    const projectDir = fixtureDir();
    const { bus, events } = makeBusRecorder();

    writeAndPublishArtifact({
      ...writeOptions(projectDir, kind, text, METADATA),
      bus,
      phase,
    });

    const persisted = readSpecFile({ projectDir, sessionId: SESSION_ID }, filename);
    expect(persisted).toContain('generated_by: splitbrief');
    expect(persisted).toContain(text);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(1);
    expect(events.find((event) => event.type === 'artifact_written')).toMatchObject({
      filename,
      phase,
    });
  });

  it('writes and publishes a Task Brief projection only with a committed generation receipt', () => {
    const projectDir = fixtureDir();
    const text = [
      '---',
      'id: T001',
      'title: Add the persistence seam',
      'action: create',
      'file: src/engine/orchestrator/artifact-write.ts',
      'depends_on: []',
      '---',
      '',
      '### Description',
      'Persist the artifact and publish one card.',
    ].join('\n');
    const { bus, events } = makeBusRecorder();

    expect(() =>
      writeAndPublishArtifact({
        ...writeOptions(projectDir, 'task-briefs', text, null),
        bus,
        phase: 'reviewing-briefs',
      }),
    ).toThrowError(expect.objectContaining({ kind: 'artifact-projection-requires-generation' }));
    expect(existsSync(join(sessionDir(projectDir, SESSION_ID), TASKS_FILE))).toBe(false);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);

    writeAndPublishArtifact({
      ...writeOptions(projectDir, 'task-briefs', text, null),
      bus,
      phase: 'reviewing-briefs',
      generation: GENERATION,
    });

    expect(existsSync(join(sessionDir(projectDir, SESSION_ID), TASKS_FILE))).toBe(true);
    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, TASKS_FILE)).toBe(text);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(1);
    expect(events.find((event) => event.type === 'artifact_written')).toMatchObject({
      filename: TASKS_FILE,
      phase: 'reviewing-briefs',
    });
  });

  it('keeps a null or omitted metadata value write-only with no generated frontmatter', () => {
    const projectDir = fixtureDir();
    const text = '# Plan\n\nNo metadata.';
    const { bus } = makeBusRecorder();

    writeAndPublishArtifact({
      ...writeOptions(projectDir, 'plan', text, null),
      bus,
    });
    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, PLAN_FILE)).toBe(text);

    writeAndPublishArtifact({
      ...writeOptions(projectDir, 'plan', text, undefined),
      bus,
    });
    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, PLAN_FILE)).toBe(text);
  });
});

describe('writeAndPublishArtifacts — whole-array prevalidation', () => {
  it('writes nothing and publishes nothing when a later item fails admission', () => {
    const projectDir = fixtureDir();
    const { bus, events } = makeBusRecorder();

    expect(() =>
      writeAndPublishArtifacts({
        projectDir,
        sessionId: SESSION_ID,
        bus,
        phase: 'planning',
        items: [
          { kind: 'research', text: '# Research\n\nFindings.' },
          { kind: 'spec', text: 'planner prose without a heading' },
        ],
        metadata: null,
        generation: GENERATION,
      }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'planning-invalid-artifact',
        data: expect.objectContaining({ phase: 'specifying', filename: SPEC_FILE }),
      }),
    );

    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
    expect(existsSync(join(sessionDir(projectDir, SESSION_ID), RESEARCH_FILE))).toBe(false);
  });

  it('writes every item after all items pass and publishes one event per item', () => {
    const projectDir = fixtureDir();
    const { bus, events } = makeBusRecorder();

    writeAndPublishArtifacts({
      projectDir,
      sessionId: SESSION_ID,
      bus,
      phase: 'planning',
      items: [
        { kind: 'research', text: '# Research\n\nFindings.' },
        { kind: 'spec', text: '# Spec\n\nRequirements.', admission: 'already-admitted' },
        { kind: 'plan', text: '# Plan\n\nSteps.', admission: 'already-admitted' },
        {
          kind: 'task-briefs',
          text: '---\nid: T001\ntitle: A task\naction: create\nfile: src/a.ts\ndepends_on: []\n---\n\n### Description\nWork.',
        },
      ],
      metadata: METADATA,
      generation: GENERATION,
    });

    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, RESEARCH_FILE)).toContain(
      'Findings.',
    );
    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, SPEC_FILE)).toContain(
      'Requirements.',
    );
    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, PLAN_FILE)).toContain('Steps.');
    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, TASKS_FILE)).toContain('id: T001');
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(4);
    expect(
      events.filter((event) => event.type === 'artifact_written').map((event) => event.filename),
    ).toEqual([RESEARCH_FILE, SPEC_FILE, PLAN_FILE, TASKS_FILE]);
  });
});

describe('projection faults — authority stays in the owner state', () => {
  function ownerState(): WorkflowState {
    const activeBrief = { revision: 1, hash: sha256Hex('brief'), path: 'brief.json' };
    const recovery = createBriefRecoveryState(
      {
        sessionId: 'sess-owner-write',
        origin: { mode: 'standard', entry: 'initial' },
        continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
        activeBrief,
        report: {
          briefHash: activeBrief.hash,
          report: { revision: 1, hash: sha256Hex('report'), path: 'brief-quality.json' },
          ruleVersion: 'quality-v1',
          issues: [],
          errorCount: 0,
        },
        qualityPolicyVersion: 'quality-v1',
      },
      { epochId: 'epoch-1' },
    );
    const permit: TaskExecutionPermit = {
      version: 1,
      epochId: 'epoch-1',
      authorityRevision: 1,
      generationId: GENERATION.generationId,
      manifestDigest: GENERATION.manifestDigest,
      tasksDigest: GENERATION.tasksDigest,
      qualityDigest: GENERATION.qualityDigest,
      approvalEvidence: {
        revision: 1,
        hash: sha256Hex('approval'),
        path: 'brief-recovery/epochs/epoch-1/payload/approval.json',
      },
      issuedAt: '2026-08-15T00:00:00.000Z',
    };
    return {
      ...createInitialState('feat'),
      phase: 'reviewing-briefs',
      briefRecovery: recovery,
      authorityRevision: 1,
      generation: GENERATION,
      permit,
    };
  }

  it('cannot revive or replace the committed permit when a projection write fails', () => {
    const wctx = makeTaskWorkflowContext();
    const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
    saveState(wctx, ownerState());
    const { bus } = makeBusRecorder();

    expect(() =>
      writeAndPublishArtifacts({
        projectDir: ref.projectDir,
        sessionId: ref.sessionId,
        bus,
        phase: 'planning',
        items: [
          { kind: 'research', text: '# Research\n\nFindings.' },
          { kind: 'spec', text: 'planner prose without a heading' },
        ],
        metadata: null,
        generation: GENERATION,
      }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'planning-invalid-artifact',
        data: expect.objectContaining({ phase: 'specifying', filename: SPEC_FILE }),
      }),
    );

    expect(loadState(ref)).toMatchObject({
      authorityRevision: 1,
      generation: GENERATION,
      permit: expect.objectContaining({ generationId: GENERATION.generationId }),
    });
    expect(resolveOwnerReadiness(ref)).toMatchObject({
      ok: true,
      generation: GENERATION,
      permit: expect.objectContaining({ generationId: GENERATION.generationId }),
    });
  });
});
