import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPlannerArtifactAttemptId,
  PlannerArtifactSemanticIdSchema,
} from '../../../../core/schemas/planner-artifact.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { prepareArtifactStageLease } from './lease.js';
import type { ArtifactStageLease } from './types.js';

const race = vi.hoisted(() => ({ path: '' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (String(args[0]) === race.path) await actual.mkdir(args[0]);
      return actual.mkdir(...args);
    },
  };
});

const tempDirs: string[] = [];
const leases: ArtifactStageLease[] = [];

afterEach(async () => {
  race.path = '';
  for (const lease of leases.splice(0)) await lease.dispose();
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

describe('createFreshMetadataDirectories', () => {
  it('keeps a lease parent between the output folder and the scope root that another writer made first', async () => {
    const root = createTempDir('artifact-stage-paths');
    tempDirs.push(root);
    const attemptId = createPlannerArtifactAttemptId();
    const leaseId = `fixture-${attemptId}`;
    const relativePath = `.splitbrief-runner/output/${leaseId}/nested/result`;
    race.path = join(root, '.splitbrief-runner', 'output', leaseId);

    const lease = await prepareArtifactStageLease({
      stagedProjectDir: root,
      provenance: {
        semanticId: PlannerArtifactSemanticIdSchema.parse('artifact-stage-test'),
        programId: null,
        batchId: null,
        attemptId,
        transport: {
          kind: 'declared-file',
          lease: { leaseId, attemptId, relativePath },
        },
        maxBytes: 96 * 1_024,
        relativePath,
      },
    });
    leases.push(lease);

    expect(statSync(race.path).isDirectory()).toBe(true);
    expect(lease.artifactPath).toBe(join(root, relativePath));
    expect(readFileSync(lease.artifactPath)).toEqual(Buffer.from([0xff]));
  });
});
