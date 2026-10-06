import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../core/schemas/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { buildRoutingPreviewMetadata } from './routing-preview.js';

describe('buildRoutingPreviewMetadata', () => {
  let projectDir: string;
  let outsideDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'routing-preview-project-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'routing-preview-outside-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('uses runtime context metadata when selecting a worker', async () => {
    const detectedContextLength = 20_000;
    const task = makeTask({ description: 'large routing input '.repeat(2000) });
    const config: Config = {
      ...makeConfig(),
      implementerProfiles: {
        default: 'cheap-detected-worker',
        profiles: {
          'cheap-detected-worker': {
            kind: 'agent',
            command: 'cheap-worker',
            model: 'cheap-model',
          },
          'standard-worker': {
            kind: 'api',
            provider: 'custom-endpoint',
            service: 'custom-endpoint',
            offering: 'payg',
            apiBase: 'https://custom-endpoint.example/v1',
            apiKey: 'test-key',
            model: 'runtime-standard',
          },
        },
      },
    };

    const [metadata] = await buildRoutingPreviewMetadata([task], {
      config,
      projectDir,
      detectedContextLength,
    });

    expect(metadata).toMatchObject({
      taskId: task.id,
      workerProfile: 'cheap-detected-worker',
      contextLength: detectedContextLength,
    });
  });

  it("counts the run's skills block in the estimate the worker actually receives", async () => {
    const task = makeTask();
    const skillsContext = `## Active Project Skills\n\n### AuthSkill\n${'s'.repeat(16_000)}`;

    const [without] = await buildRoutingPreviewMetadata([task], {
      config: makeConfig(),
      projectDir,
    });
    const [withSkills] = await buildRoutingPreviewMetadata([task], {
      config: makeConfig(),
      projectDir,
      skillsContext,
    });

    expect((withSkills?.estimatedTokens ?? 0) - (without?.estimatedTokens ?? 0)).toBeGreaterThan(
      3_000,
    );
  });

  it('counts the project name line the worker receives', async () => {
    const task = makeTask();
    const [unnamed] = await buildRoutingPreviewMetadata([task], {
      config: makeConfig(),
      projectDir,
    });
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'n'.repeat(8_000) }));
    const [named] = await buildRoutingPreviewMetadata([task], {
      config: makeConfig(),
      projectDir,
    });

    expect((named?.estimatedTokens ?? 0) - (unnamed?.estimatedTokens ?? 0)).toBeGreaterThan(1_000);
  });

  it('refreshes current code for confined modify targets', async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'app.ts'), 'export const ok = true;');
    const task = makeTask({
      action: 'modify',
      suggestedFiles: ['src/app.ts'],
      currentCode: 'export const stale = true;',
    });

    const [metadata] = await buildRoutingPreviewMetadata([task], {
      config: makeConfig(),
      projectDir,
    });

    expect(metadata).toMatchObject({
      taskId: task.id,
      estimateStatus: 'refreshed-current-code',
      risk: 'medium',
    });
    expect(metadata?.validationStatus).toBeUndefined();
    expect(metadata?.routingReason).not.toContain('missing current code');
  });

  it('marks confined missing modify targets as needing review refresh', async () => {
    const task = makeTask({
      action: 'modify',
      suggestedFiles: ['src/missing.ts'],
      currentCode: 'export const stale = true;',
    });

    const [metadata] = await buildRoutingPreviewMetadata([task], {
      config: makeConfig(),
      projectDir,
    });

    expect(metadata).toMatchObject({
      taskId: task.id,
      estimateStatus: 'missing-current-code',
      validationStatus: 'warn',
      risk: 'high',
      currentCodeContextMode: 'none',
    });
    expect(metadata?.routingReason).toContain('missing current code');
  });

  it('reports a modify target an earlier task creates as pending, not missing', async () => {
    const created = makeTask({ id: 'T001', action: 'create', suggestedFiles: ['src/new.ts'] });
    const modified = makeTask({
      id: 'T002',
      action: 'modify',
      suggestedFiles: ['src/new.ts'],
      currentCode: 'export const stale = true;',
    });

    const [createdMetadata, modifiedMetadata] = await buildRoutingPreviewMetadata(
      [created, modified],
      { config: makeConfig(), projectDir },
    );

    expect(createdMetadata?.estimateStatus).toBeUndefined();
    expect(modifiedMetadata).toMatchObject({
      taskId: modified.id,
      estimateStatus: 'pending-earlier-task',
      risk: 'medium',
    });
    expect(modifiedMetadata?.validationStatus).toBeUndefined();
    expect(modifiedMetadata?.routingReason).toContain(
      'an earlier task in this plan creates the target file',
    );
  });

  it('reports a modify target created by a later task as missing, because the loop runs in array order', async () => {
    const modified = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/new.ts'],
      currentCode: 'export const stale = true;',
    });
    const created = makeTask({ id: 'T002', action: 'create', suggestedFiles: ['src/new.ts'] });

    const [metadata] = await buildRoutingPreviewMetadata([modified, created], {
      config: makeConfig(),
      projectDir,
    });

    expect(metadata).toMatchObject({
      taskId: modified.id,
      estimateStatus: 'missing-current-code',
      validationStatus: 'warn',
      risk: 'high',
    });
    expect(metadata?.routingReason).toContain('missing current code');
  });

  it('normalises ./ prefixes when matching a create task to a modify target', async () => {
    const created = makeTask({ id: 'T001', action: 'create', suggestedFiles: ['./src/new.ts'] });
    const modified = makeTask({ id: 'T002', action: 'modify', suggestedFiles: ['src/new.ts'] });

    const [, modifiedMetadata] = await buildRoutingPreviewMetadata([created, modified], {
      config: makeConfig(),
      projectDir,
    });

    expect(modifiedMetadata?.estimateStatus).toBe('pending-earlier-task');
  });

  it.each([
    ['relative traversal', join('..', 'outside', 'secret.txt')],
    ['absolute path', join(tmpdir(), 'secret-outside.ts')],
  ])('treats %s targets as unavailable current code', async (_label, file) => {
    const task = makeTask({ action: 'modify', suggestedFiles: [file], currentCode: 'stale' });

    const [metadata] = await buildRoutingPreviewMetadata([task], {
      config: makeConfig(),
      projectDir,
    });

    expect(metadata).toMatchObject({
      taskId: task.id,
      estimateStatus: 'current-code-unavailable',
      validationStatus: 'warn',
      risk: 'high',
      currentCodeContextMode: 'none',
    });
  });

  it('treats symlink escapes as unavailable current code', async () => {
    writeFileSync(join(outsideDir, 'secret.txt'), 'SECRET OUTSIDE CONTENT');
    symlinkSync(outsideDir, join(projectDir, 'linked'));
    const task = makeTask({
      action: 'modify',
      suggestedFiles: ['linked/secret.txt'],
      currentCode: 'stale',
    });

    const [metadata] = await buildRoutingPreviewMetadata([task], {
      config: makeConfig(),
      projectDir,
    });

    expect(metadata).toMatchObject({
      taskId: task.id,
      estimateStatus: 'current-code-unavailable',
      validationStatus: 'warn',
      risk: 'high',
      currentCodeContextMode: 'none',
    });
  });
});
