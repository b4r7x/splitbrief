import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { estimatePlanContextFits } from './plan-context-fit.js';

let projectDir: string;
beforeEach(() => {
  projectDir = createTempDir('plan-context-fit');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
});
afterEach(() => cleanupTempDir(projectDir));

const config = makeConfig({
  implementerProfiles: {
    default: 'small',
    profiles: {
      small: {
        kind: 'api',
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        model: 'small',
        contextLength: 8_000,
      },
    },
  },
});

const wide = makeConfig({
  implementerProfiles: {
    default: 'wide',
    profiles: {
      wide: {
        kind: 'api',
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        model: 'wide',
        contextLength: 32_000,
      },
    },
  },
});

const singleFile = makeConfig({
  implementerProfiles: {
    default: 'script',
    profiles: { script: { kind: 'shell', command: 'gen', model: 'gen', contextLength: 32_000 } },
  },
});

describe('estimatePlanContextFits', () => {
  it('estimates each task with the fresh code of its context files', async () => {
    writeFileSync(join(projectDir, 'src', 'big.ts'), 'export const x = 1;\n'.repeat(1_800));
    const plan = makePlanProposal({
      tasks: [
        makeTaskSpec({ contextFiles: ['src/big.ts'] }),
        makeTaskSpec({ id: 'T002', suggestedFiles: ['src/b.ts'] }),
        makeTaskSpec({ id: 'T003', contextFiles: ['../outside.ts'] }),
      ],
    });

    const fits = await estimatePlanContextFits(plan, { config, projectDir });

    expect([...fits]).toEqual([
      ['T001', { fit: 'overflow', blocked: expect.any(String) }],
      ['T002', { fit: 'fits' }],
    ]);
  });

  it('counts the plan context every brief carries', async () => {
    const tasks = [makeTaskSpec()];
    const bare = makePlanProposal({ decisions: [], tasks });
    const heavy = makePlanProposal({
      decisions: ['Keep the greeting in one module and reuse the shared formatter. '.repeat(500)],
      tasks,
    });

    expect((await estimatePlanContextFits(bare, { config, projectDir })).get('T001')).toEqual({
      fit: 'fits',
    });
    expect((await estimatePlanContextFits(heavy, { config, projectDir })).get('T001')).toEqual({
      fit: 'overflow',
      blocked: expect.any(String),
    });
  });

  it('gives no estimate to a task that names a directory, so checkPlan can refuse it', async () => {
    const plan = makePlanProposal({
      tasks: [
        makeTaskSpec({ contextFiles: ['src'] }),
        makeTaskSpec({ id: 'T002', suggestedFiles: ['src'] }),
        makeTaskSpec({ id: 'T003', suggestedFiles: ['src/c.ts'] }),
      ],
    });

    const fits = await estimatePlanContextFits(plan, { config, projectDir });

    expect([...fits]).toEqual([['T003', { fit: 'fits' }]]);
  });

  it('routes a task with a read-only context file to an extracted-code implementer', async () => {
    writeFileSync(join(projectDir, 'src', 'types.ts'), 'export type Name = string;\n');
    const plan = makePlanProposal({ tasks: [makeTaskSpec({ contextFiles: ['src/types.ts'] })] });

    const fits = await estimatePlanContextFits(plan, { config: wide, projectDir });

    expect([...fits]).toEqual([['T001', { fit: 'fits' }]]);
  });

  it('names the routing reason of a task that fits but that no implementer can take', async () => {
    const plan = makePlanProposal({
      tasks: [makeTaskSpec({ suggestedFiles: ['src/a.ts', 'src/b.ts'] })],
    });

    const fits = await estimatePlanContextFits(plan, { config: singleFile, projectDir });

    expect(fits.get('T001')).toEqual({
      fit: 'fits',
      blocked: expect.stringContaining('No capable implementer profile'),
    });
  });
});
