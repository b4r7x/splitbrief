import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { buildManifest, writeManifest } from './manifest.js';
import { HandoffManifestSchema } from '../../core/schemas/handoff-manifest.js';

const task1 = makeTask({ id: 'T001', title: 'Add auth middleware' });
const task2 = makeTask({ id: 'T002', title: 'Add user model', dependsOn: ['T001'] });

const baseOptions = {
  sessionId: 'test-session',
  diptychVersion: '1.0.0',
  target: 'spec-kit' as const,
  mode: 'standard' as const,
  tasks: [task1, task2],
  packFiles: ['tasks/T001.md', 'tasks/T002.md', 'README.md'],
};

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('manifest-test');
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('buildManifest', () => {
  it('sets all three artifact fields when spec, plan, and constitution are provided', () => {
    const manifest = buildManifest({
      ...baseOptions,
      spec: '# Spec content',
      plan: '# Plan content',
      constitution: '# Constitution content',
    });

    expect(manifest.artifacts.spec).toBe('spec.md');
    expect(manifest.artifacts.plan).toBe('plan.md');
    expect(manifest.artifacts.constitution).toBe('constitution.md');
  });

  it('omits spec, plan, and constitution artifact fields when not provided', () => {
    const manifest = buildManifest({ ...baseOptions });

    expect(manifest.artifacts.spec).toBeUndefined();
    expect(manifest.artifacts.plan).toBeUndefined();
    expect(manifest.artifacts.constitution).toBeUndefined();
  });

  it('omits spec, plan, and constitution artifact fields when null', () => {
    const manifest = buildManifest({
      ...baseOptions,
      spec: null,
      plan: null,
      constitution: null,
    });

    expect(manifest.artifacts.spec).toBeUndefined();
    expect(manifest.artifacts.plan).toBeUndefined();
    expect(manifest.artifacts.constitution).toBeUndefined();
  });

  it('briefHash is a 64-character hex string (sha256)', () => {
    const manifest = buildManifest({ ...baseOptions });

    expect(manifest.briefHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives artifacts.tasks from packFiles filtered to entries under tasks/', () => {
    const manifest = buildManifest({ ...baseOptions });

    expect(manifest.artifacts.tasks).toEqual(['tasks/T001.md', 'tasks/T002.md']);
    expect(manifest.artifacts.tasks).not.toContain('README.md');
  });

  it('packVersion is the string literal "1"', () => {
    const manifest = buildManifest({ ...baseOptions });

    expect(manifest.packVersion).toBe('1');
  });

  it('sets taskIds from the tasks array', () => {
    const manifest = buildManifest({ ...baseOptions });

    expect(manifest.taskIds).toEqual(['T001', 'T002']);
  });

  it('custom target string (not a built-in) is accepted', () => {
    const manifest = buildManifest({
      ...baseOptions,
      target: 'my-custom-renderer',
    });

    expect(manifest.target).toBe('my-custom-renderer');
  });
});

describe('writeManifest', () => {
  it('writes parseable JSON at manifest.json inside the given directory', () => {
    const manifest = buildManifest({ ...baseOptions });
    writeManifest(tmp, manifest);

    const manifestPath = join(tmp, 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);

    const raw = readFileSync(manifestPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const result = HandoffManifestSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});
