import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { readSpecFile, writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import { PLAN_FILE, SPEC_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { writeAndPublishArtifact, type ArtifactKind } from './artifact-write.js';

const SESSION_ID = 'artifact-write-test';
const METADATA: SpecMetadata = {
  plannerTool: 'claude-code',
  plannerModel: 'opus',
  implementerTool: 'codex',
  implementerModel: 'gpt-5',
  mode: 'standard',
};

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir !== undefined) cleanupTempDir(tempDir);
  tempDir = undefined;
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
  ])('rejects an invalid $kind replacement before changing bytes or publishing', ({
    kind,
    filename,
    phase,
  }) => {
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
  });

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

  it('writes and publishes a Task Brief card without planning admission', () => {
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

    writeAndPublishArtifact({
      ...writeOptions(projectDir, 'task-briefs', text, null),
      bus,
      phase: 'reviewing-briefs',
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
