import { describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { callPhase } from '#testing/helpers/planner-call.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { sha256Hex } from '../../utils/sha256.js';
import {
  apiContextError,
  apiContextRecoveryFacts,
  readApiContextDiagnostic,
  type ApiContextDiagnostic,
} from '../providers/api-context-diagnostic.js';
import {
  apiPlanningInputBudget,
  buildApiPlanningContext,
  type ApiContextManifestEntry,
  type ApiPlanningContext,
} from './api-context.js';
import { createPlannerBase } from './base.js';
import { buildProjectContext } from './context.js';
import { ONE_SHOT_API_CAPS } from './types.js';

type PacketInput = Parameters<typeof buildApiPlanningContext>[0];
type Overrides = Partial<PacketInput> & Pick<PacketInput, 'request'>;

const ROOMY = 1_000_000;

function write(dir: string, relative: string, content: string | Buffer): void {
  const full = join(dir, relative);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function build(dir: string, overrides: Overrides): Promise<ApiPlanningContext> {
  return buildApiPlanningContext({
    projectDir: dir,
    project: { markdown: '', notes: [] },
    availableTokens: ROOMY,
    ...overrides,
  });
}

function entryFor(
  manifest: readonly ApiContextManifestEntry[],
  path: string,
): ApiContextManifestEntry | undefined {
  return manifest.find((candidate) => candidate.path === path);
}

function insufficient(result: ApiPlanningContext) {
  if (result.kind !== 'insufficient-context') throw new Error(`expected a refusal, got complete`);
  return result;
}

function complete(result: ApiPlanningContext) {
  if (result.kind !== 'complete') {
    throw new Error(`expected complete, refused: ${result.missingSections.join(', ')}`);
  }
  return result;
}

describe('planning context completeness', () => {
  it('includes canonical instructions and declared short, dot, and extensionless files whole', async () => {
    await withTempDir('api-context-explicit', async (dir) => {
      for (const path of ['AGENTS.md', 'CLAUDE.md', 'Dockerfile', '.gitignore', 'a.ts']) {
        write(dir, path, `${path} complete contents\n`);
      }
      const result = complete(
        await build(dir, {
          request: 'Modify `Dockerfile` and `.gitignore`.',
          taskFiles: ['a.ts'],
        }),
      );
      for (const path of ['AGENTS.md', 'CLAUDE.md', 'Dockerfile', '.gitignore', 'a.ts']) {
        expect(result.text).toContain(`${path} complete contents\n`);
        expect(entryFor(result.manifest, path)).toMatchObject({
          kind: 'required',
          state: 'included',
        });
      }
    });
  });

  it.each(['../outside.ts', '/tmp/outside.ts', 'src/../outside.ts'])(
    'refuses an unsafe explicit target %s',
    async (path) => {
      await withTempDir('api-context-unsafe', async (dir) => {
        const result = insufficient(
          await build(dir, { request: 'Modify the declared target.', taskFiles: [path] }),
        );
        expect(result.cause).toBe('unsupported-required');
        expect(result.missingSections).toContain(path);
      });
    },
  );

  it('refuses unreadable canonical instructions', async () => {
    await withTempDir('api-context-instructions', async (dir) => {
      write(dir, 'AGENTS.md', Buffer.from([0]));
      const result = insufficient(await build(dir, { request: 'Add a greeting.' }));
      expect(result.cause).toBe('unsupported-required');
      expect(result.missingSections).toContain('AGENTS.md');
    });
  });

  it('gives a request that names a file for modification that file, byte for byte', async () => {
    await withTempDir('api-context', async (dir) => {
      const source = 'export function alpha(): void {\n  return;\n}\n';
      write(dir, 'src/alpha.ts', source);

      const result = complete(
        await build(dir, { request: 'Please modify `src/alpha.ts` so it logs.' }),
      );

      expect(entryFor(result.manifest, 'src/alpha.ts')).toEqual({
        path: 'src/alpha.ts',
        kind: 'required',
        state: 'included',
        sha256: sha256Hex(source),
      });
      expect(result.text).toContain(source);
      expect(result.text).toContain(`src/alpha.ts — whole file, sha256 ${sha256Hex(source)}`);
      // Whole, not excerpted: a required file carries no line interval.
      expect(result.text).not.toContain('src/alpha.ts — lines');
    });
  });

  it('takes a path named without backticks when it resolves to a real file', async () => {
    await withTempDir('api-context', async (dir) => {
      write(dir, 'src/bare.ts', 'export const bare = 1;\n');

      const result = complete(
        await build(dir, { request: 'Update src/bare.ts and mention e.g. the flag.' }),
      );

      expect(entryFor(result.manifest, 'src/bare.ts')?.state).toBe('included');
      // Prose is not a path: `e.g.` never becomes a manifest line.
      expect(result.manifest.map((entry) => entry.path)).toEqual(['src/bare.ts']);
    });
  });

  it('recognizes natural existing path words without treating ordinary prose as paths', async () => {
    await withTempDir('api-context-natural-paths', async (dir) => {
      for (const path of ['Dockerfile', '.env', 'a.ts']) write(dir, path, `${path} contents\n`);

      const result = complete(
        await build(dir, { request: 'Modify Dockerfile, .env, and a.ts in place.' }),
      );

      expect(result.manifest.map((entry) => entry.path)).toEqual(['.env', 'Dockerfile', 'a.ts']);
      expect(result.text).toContain('Dockerfile contents\n');
      expect(result.text).toContain('.env contents\n');
      expect(result.text).toContain('a.ts contents\n');
      expect(result.text).not.toContain('e.g.');
    });
  });

  it('refuses an unsafe natural path instead of silently omitting it', async () => {
    await withTempDir('api-context-natural-unsafe', async (dir) => {
      const result = insufficient(await build(dir, { request: 'Modify ../outside.ts in place.' }));
      expect(result.cause).toBe('unsupported-required');
      expect(result.missingSections).toEqual(['../outside.ts']);
    });
  });

  it('does not require a path introduced by a later create clause', async () => {
    await withTempDir('api-context-natural-create', async (dir) => {
      write(dir, 'a.ts', 'existing source\n');

      const result = complete(await build(dir, { request: 'Modify a.ts and create b.ts.' }));

      expect(entryFor(result.manifest, 'a.ts')?.state).toBe('included');
      expect(entryFor(result.manifest, 'b.ts')).toMatchObject({
        kind: 'optional',
        state: 'missing',
      });
    });
  });

  it('does not treat a URL in a later clause as a source path', async () => {
    await withTempDir('api-context-natural-url', async (dir) => {
      write(dir, 'a.ts', 'existing source\n');

      const result = complete(
        await build(dir, {
          request: 'Modify a.ts; consult https://example.com/documentation.',
        }),
      );

      expect(result.manifest.map((entry) => entry.path)).toEqual(['a.ts']);
      expect(result.text).not.toContain('example.com');
    });
  });

  it('refuses a required file that is binary or invalid UTF-8', async () => {
    const cases: Array<[string, Buffer]> = [
      ['src/blob.ts', Buffer.from([0x41, 0x00, 0x42])],
      ['src/bad-utf8.ts', Buffer.from([0xff, 0xfe, 0x41])],
    ];
    for (const [path, bytes] of cases) {
      await withTempDir('api-context', async (dir) => {
        write(dir, path, bytes);
        const result = insufficient(await build(dir, { request: `Modify \`${path}\` in place.` }));
        expect(result.cause, path).toBe('unsupported-required');
        expect(result.missingSections).toEqual([path]);
        expect(entryFor(result.manifest, path)).toEqual({
          path,
          kind: 'required',
          state: 'unsupported',
        });
      });
    }
  });

  it('refuses a required file that would be read through a symlink', async () => {
    await withTempDir('api-context', async (dir) => {
      write(dir, 'outside.txt', 'not part of the packet\n');
      mkdirSync(join(dir, 'src'), { recursive: true });
      symlinkSync(join(dir, 'outside.txt'), join(dir, 'src', 'link.ts'));

      const result = insufficient(await build(dir, { request: 'Modify `src/link.ts` in place.' }));

      expect(result.cause).toBe('unsupported-required');
      expect(result.missingSections).toEqual(['src/link.ts']);
      expect(entryFor(result.manifest, 'src/link.ts')?.state).toBe('unsupported');
    });
  });

  it('refuses when a phase artifact the step declares is not there', async () => {
    await withTempDir('api-context', async (dir) => {
      const result = insufficient(
        await build(dir, {
          request: 'Write the plan.',
          artifacts: [
            { name: 'research.md', text: '# Research\n\nFindings.', required: true },
            { name: 'spec.md', text: '   \n', required: true },
          ],
        }),
      );

      expect(result.cause).toBe('missing-required');
      expect(result.missingSections).toEqual(['spec.md']);
      expect(entryFor(result.manifest, 'spec.md')).toEqual({
        path: 'spec.md',
        kind: 'required',
        state: 'missing',
      });
      expect(entryFor(result.manifest, 'research.md')?.state).toBe('included');
    });
  });

  it('refuses a named path described as existing, and records a requested new one as absent', async () => {
    await withTempDir('api-context', async (dir) => {
      const refused = insufficient(
        await build(dir, { request: 'Update `src/ghost.ts` so it exports a flag.' }),
      );
      expect(refused.cause).toBe('missing-required');
      expect(refused.missingSections).toEqual(['src/ghost.ts']);

      const allowed = complete(
        await build(dir, { request: 'Create `src/ghost.ts` with one export.' }),
      );
      expect(entryFor(allowed.manifest, 'src/ghost.ts')).toEqual({
        path: 'src/ghost.ts',
        kind: 'optional',
        state: 'missing',
      });
      expect(allowed.text).toContain('- src/ghost.ts — not present in the project');
    });
  });

  it('requires every declared task target that exists and records the rest absent', async () => {
    await withTempDir('api-context', async (dir) => {
      const source = 'export const declared = 1;\n';
      write(dir, 'src/declared.ts', source);

      const result = complete(
        await build(dir, {
          request: 'Build the briefs.',
          taskFiles: ['src/declared.ts', 'src/to-create.ts'],
        }),
      );

      expect(entryFor(result.manifest, 'src/declared.ts')?.state).toBe('included');
      expect(result.text).toContain(source);
      expect(entryFor(result.manifest, 'src/to-create.ts')).toEqual({
        path: 'src/to-create.ts',
        kind: 'optional',
        state: 'missing',
      });
    });
  });

  it('records the exact line interval of an optional excerpt and names what it omitted', async () => {
    await withTempDir('api-context', async (dir) => {
      const beta = Array.from({ length: 60 }, (_, i) => `export const beta${i} = ${i};`).join('\n');
      write(dir, 'src/beta.ts', beta);
      write(dir, 'src/gamma.ts', 'export const gamma = 0;\n');

      const result = complete(
        await build(dir, {
          request: 'Add a feature.',
          repoMap: 'src/beta.ts:\n  export const beta0\n\nsrc/gamma.ts:\n  export const gamma',
          availableTokens: 64,
        }),
      );

      const excerpt = entryFor(result.manifest, 'src/beta.ts');
      expect(excerpt?.kind).toBe('optional');
      expect(excerpt?.state).toBe('excerpt');
      expect(excerpt?.startLine).toBe(1);
      const endLine = excerpt?.endLine ?? 0;
      expect(endLine).toBeGreaterThan(0);
      expect(endLine).toBeLessThan(60);
      expect(result.text).toContain(`src/beta.ts — lines 1-${endLine} of 60`);
      expect(result.text).toContain(beta.split('\n').slice(0, endLine).join('\n'));
      expect(result.text).not.toContain(`export const beta${endLine} = ${endLine};`);
      expect(result.text).toContain(`- src/beta.ts — lines 1-${endLine} only`);

      expect(entryFor(result.manifest, 'src/gamma.ts')).toEqual({
        path: 'src/gamma.ts',
        kind: 'optional',
        state: 'omitted',
      });
      expect(result.text).toContain(
        "- src/gamma.ts — not supplied, outside this call's context allocation",
      );
      expect(result.text).toContain('no filesystem, shell or search tool');
    });
  });

  it('names the required sections that do not fit instead of cutting them down', async () => {
    await withTempDir('api-context', async (dir) => {
      write(
        dir,
        'src/big.ts',
        Array.from({ length: 400 }, (_, i) => `export const b${i} = ${i};`).join('\n'),
      );

      const result = insufficient(
        await build(dir, { request: 'Modify `src/big.ts` end to end.', availableTokens: 100 }),
      );

      expect(result.cause).toBe('input-budget');
      expect(result.missingSections).toContain('src/big.ts');
      expect(result.availableTokens).toBe(100);
      expect(result.requiredTokens).toBeGreaterThan(100);
      // Read, but not supplied: never reported as if the call would carry it.
      expect(entryFor(result.manifest, 'src/big.ts')?.state).toBe('omitted');
    });
  });

  it('states a truncated README rather than passing it off as whole', async () => {
    await withTempDir('api-context', async (dir) => {
      write(dir, 'README.md', Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'));
      write(dir, 'src/one.ts', 'export const one = 1;\n');

      const project = await buildProjectContext(dir);
      expect(project.notes).toEqual([
        { kind: 'readme-truncated', path: 'README.md', includedLines: 50, totalLines: 60 },
      ]);

      const result = complete(await build(dir, { project, request: 'Add a feature.' }));
      expect(result.text).toContain('- README.md — first 50 of 60 lines');
    });
  });

  it('produces the same packet in the same order for the same inputs', async () => {
    await withTempDir('api-context', async (dir) => {
      write(dir, 'src/alpha.ts', 'export const alpha = 1;\n');
      write(dir, 'src/beta.ts', 'export const beta = 2;\n');
      const overrides: Overrides = {
        request: 'Modify `src/beta.ts` and `src/alpha.ts` together.',
        repoMap: 'src/beta.ts:\n  beta\n\nsrc/alpha.ts:\n  alpha',
      };

      const first = complete(await build(dir, overrides));
      const second = complete(await build(dir, overrides));

      expect(second.text).toEqual(first.text);
      expect(second.manifest).toEqual(first.manifest);
      expect(first.manifest.map((entry) => entry.path)).toEqual(['src/alpha.ts', 'src/beta.ts']);
    });
  });

  it('reassembles the source from the files as they are now, never from the last packet', async () => {
    await withTempDir('api-context', async (dir) => {
      write(dir, 'src/alpha.ts', 'export const alpha = 1;\n');
      const request = 'Modify `src/alpha.ts` once more.';
      const before = complete(await build(dir, { request }));

      const updated = 'export const alpha = 2;\nexport const added = true;\n';
      write(dir, 'src/alpha.ts', updated);
      const after = complete(await build(dir, { request }));

      expect(after.text).toContain(updated);
      expect(after.text).not.toContain('export const alpha = 1;');
      expect(entryFor(after.manifest, 'src/alpha.ts')?.sha256).toBe(sha256Hex(updated));
      expect(entryFor(before.manifest, 'src/alpha.ts')?.sha256).not.toBe(sha256Hex(updated));
    });
  });

  it('allocates the seat context minus the output reserve, and nothing below zero', () => {
    expect(apiPlanningInputBudget(undefined)).toBe(8_192 - 2_048);
    expect(apiPlanningInputBudget(32_000)).toBe(32_000 - 2_048);
    expect(apiPlanningInputBudget(1_000)).toBe(0);
  });
});

describe('the insufficiency the PLAN seat hands to recovery', () => {
  const diagnostic: ApiContextDiagnostic = {
    code: 'insufficient-context',
    seat: 'plan',
    cause: 'missing-required',
    missingSections: ['spec.md', 'src/alpha.ts'],
    model: 'qwen-coder',
    requiredTokens: 9_000,
    availableTokens: 6_144,
  };

  it('carries the diagnosis as data and keeps every figure out of the summary', () => {
    const err = apiContextError(diagnostic);
    expect(err.kind).toBe('api-insufficient-context');
    expect(err.data.diagnostic).toEqual(diagnostic);
    expect(err.message).toContain('planning seat');
    expect(err.message).toContain('spec.md');
    // Qualitative only: no figure of any kind reaches the summary.
    expect(err.message).not.toMatch(/\d/);
    expect(err.message).not.toContain('token');
  });

  it('reads the diagnosis back from the error without matching its message', () => {
    const err = apiContextError(diagnostic);
    expect(readApiContextDiagnostic(err)).toEqual(diagnostic);
    expect(readApiContextDiagnostic(err.data)).toEqual(diagnostic);
    expect(readApiContextDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(readApiContextDiagnostic({ ...diagnostic, cause: 'made-up' })).toBeNull();
    expect(readApiContextDiagnostic('insufficient-context')).toBeNull();
  });

  it('spells every missing section and only the measurements that were taken', () => {
    expect(apiContextRecoveryFacts(diagnostic)).toEqual({
      apiContextCode: 'insufficient-context',
      apiContextSeat: 'plan',
      apiContextCause: 'missing-required',
      apiContextMissingSectionsJson: JSON.stringify(['spec.md', 'src/alpha.ts']),
      apiContextModel: 'qwen-coder',
      apiContextRequiredTokens: 9_000,
      apiContextAvailableTokens: 6_144,
    });
    expect(
      apiContextRecoveryFacts({
        code: 'insufficient-context',
        seat: 'review',
        cause: 'unsupported-required',
        missingSections: [],
      }),
    ).toEqual({
      apiContextCode: 'insufficient-context',
      apiContextSeat: 'review',
      apiContextCause: 'unsupported-required',
      apiContextMissingSectionsJson: '[]',
    });
  });

  it('preserves producer budget provenance and omitted wire options when present', () => {
    const measured: ApiContextDiagnostic = {
      ...diagnostic,
      budgetSource: 'observed-active',
      omittedRequestOptions: ['temperature', 'stream_options.include_usage'],
    };

    expect(apiContextRecoveryFacts(measured)).toMatchObject({
      apiContextBudgetSource: 'observed-active',
      apiContextOmittedRequestOptionsJson: JSON.stringify([
        'temperature',
        'stream_options.include_usage',
      ]),
    });
    expect(readApiContextDiagnostic(apiContextError(measured))).toEqual(measured);
  });
});

describe('a PLAN seat that reads no files of its own', () => {
  function recordingApiPlanner() {
    const prompts: string[] = [];
    const planner = createPlannerBase({
      invokePlan: async ({ prompt }) => {
        prompts.push(prompt);
        return makeRunnerCallResult({ status: 'completed', text: '# Research\n\nFindings.' });
      },
      invokeEscalate: async () => makeRunnerCallResult({ status: 'completed', text: '' }),
      isAvailable: async () => true,
      backendKind: 'api',
      model: 'qwen-coder',
      consumesPriorMessages: true,
      planningContextBudget: ROOMY,
      capabilities: ONE_SHOT_API_CAPS,
    });
    return { planner, prompts };
  }

  it('supplies the named source in the prompt it dispatches', async () => {
    await withTempDir('api-context-seat', async (dir) => {
      const source = 'export const wired = true;\n';
      write(dir, 'src/wired.ts', source);
      const { planner, prompts } = recordingApiPlanner();

      await callPhase(planner, {
        call: 'research',
        feature: 'Modify `src/wired.ts` so it logs.',
        projectDir: dir,
        callbacks: { onOutput: () => {} },
      });

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(source);
      expect(prompts[0]).toContain('no filesystem, shell or search tool');
    });
  });

  it('refuses before anything is dispatched when the packet is incomplete', async () => {
    await withTempDir('api-context-seat', async (dir) => {
      const { planner, prompts } = recordingApiPlanner();

      await expect(
        callPhase(planner, {
          call: 'plan',
          feature: 'Write the plan.',
          spec: '',
          projectDir: dir,
          callbacks: { onOutput: () => {} },
        }),
      ).rejects.toMatchObject({ kind: 'api-insufficient-context' });
      expect(prompts).toEqual([]);
    });
  });
});
