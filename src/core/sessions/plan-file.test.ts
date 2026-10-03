import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makePlanProposal } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { readSpecFile } from '../paths-io.js';
import { PLAN_JSON_FILE } from '../paths.js';
import { parsePlanJson, writePlanJson } from './plan-file.js';

let projectDir: string;
beforeEach(() => {
  projectDir = createTempDir('plan-file');
});
afterEach(() => cleanupTempDir(projectDir));

describe('plan.json', () => {
  it('round-trips the plan', () => {
    const ref = { projectDir, sessionId: 'sess-plan' };
    const plan = makePlanProposal();
    writePlanJson(ref, plan);
    expect(parsePlanJson(readSpecFile(ref, PLAN_JSON_FILE) ?? '')).toEqual({ plan });
  });

  it('names why a file is not a plan', () => {
    expect(parsePlanJson('{"kind":"plan"}')).toMatchObject({ errors: expect.any(Array) });
    expect(parsePlanJson('{')).toMatchObject({
      errors: [expect.stringMatching(/^plan\.json is not valid JSON/)],
    });
  });
});
