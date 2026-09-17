import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { ImplementerBaseConfig } from './pipeline/run.js';
import type { ImplementerResult } from './types.js';
import {
  FILE_BUNDLE_MAX_FILES,
  FileBundleSchema,
  selectBuildOutputContract,
  type BundleApplyResult,
} from './file-bundle.js';
import { createApiImplementer } from './api.js';
import { createShellImplementer } from './shell.js';
import { createAgentImplementer } from './agent.js';

const captured = vi.hoisted(() => ({ configs: [] as unknown[] }));

vi.mock('./pipeline/run.js', () => ({
  createImplementerBase: (config: unknown) => {
    captured.configs.push(config);
    return {};
  },
}));

function capturedBackend(create: () => unknown): ImplementerBaseConfig {
  captured.configs.length = 0;
  create();
  expect(captured.configs).toHaveLength(1);
  return captured.configs[0] as ImplementerBaseConfig;
}

const entry = { path: 'src/a.ts', action: 'modify', content: 'export const a = 1;\n' };

describe('FileBundleSchema', () => {
  it('accepts a one-file and a multi-file bundle of create and modify entries', () => {
    expect(FileBundleSchema.safeParse({ version: 1, files: [entry] }).success).toBe(true);
    expect(
      FileBundleSchema.safeParse({
        version: 1,
        files: [entry, { path: 'src/b.ts', action: 'create', content: 'export {};\n' }],
      }).success,
    ).toBe(true);
  });

  it('keeps empty content as complete file text', () => {
    const parsed = FileBundleSchema.parse({
      version: 1,
      files: [{ path: 'src/empty.ts', action: 'create', content: '' }],
    });
    expect(parsed.files[0]?.content).toBe('');
  });

  it('rejects unknown keys at the bundle and the entry level', () => {
    expect(FileBundleSchema.safeParse({ version: 1, files: [entry], note: 'x' }).success).toBe(
      false,
    );
    expect(
      FileBundleSchema.safeParse({ version: 1, files: [{ ...entry, mode: 0o755 }] }).success,
    ).toBe(false);
    expect(
      FileBundleSchema.safeParse({ version: 1, files: [{ ...entry, encoding: 'base64' }] }).success,
    ).toBe(false);
  });

  it('rejects any action other than create or modify', () => {
    for (const action of ['delete', 'rename', 'chmod', 'binary', 'replace']) {
      expect(
        FileBundleSchema.safeParse({ version: 1, files: [{ ...entry, action }] }).success,
      ).toBe(false);
    }
    expect(
      FileBundleSchema.safeParse({
        version: 1,
        files: [{ path: 'src/a.ts', action: 'rename', to: 'src/b.ts' }],
      }).success,
    ).toBe(false);
  });

  it('rejects every version but 1', () => {
    for (const version of [2, 0, '1', undefined]) {
      expect(FileBundleSchema.safeParse({ version, files: [entry] }).success).toBe(false);
    }
  });

  it('rejects missing fields and non-string content', () => {
    expect(FileBundleSchema.safeParse({ version: 1, files: [] }).success).toBe(false);
    expect(FileBundleSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(
      FileBundleSchema.safeParse({ version: 1, files: [{ path: 'src/a.ts', action: 'modify' }] })
        .success,
    ).toBe(false);
    expect(
      FileBundleSchema.safeParse({ version: 1, files: [{ ...entry, content: null }] }).success,
    ).toBe(false);
  });

  it('caps a bundle at the declared-target maximum', () => {
    const files = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        path: `src/f${i}.ts`,
        action: 'create',
        content: '',
      }));
    expect(
      FileBundleSchema.safeParse({ version: 1, files: files(FILE_BUNDLE_MAX_FILES) }).success,
    ).toBe(true);
    expect(
      FileBundleSchema.safeParse({ version: 1, files: files(FILE_BUNDLE_MAX_FILES + 1) }).success,
    ).toBe(false);
  });

  it('does not read a legacy code response as a bundle', () => {
    expect(FileBundleSchema.safeParse('```ts\nexport const a = 1;\n```').success).toBe(false);
  });
});

describe('selectBuildOutputContract', () => {
  it('selects the bundle grammar for the API backend', () => {
    const api = capturedBackend(() => createApiImplementer(makeConfig()));
    expect(selectBuildOutputContract(api)).toBe('file-bundle-v1');
  });

  it('keeps the legacy code grammar for the shell backend', () => {
    const shell = capturedBackend(() =>
      createShellImplementer(
        makeConfig({
          implementer: {
            model: 'test',
            kind: 'shell',
            command: 'my-ai-tool',
            outputFormat: 'text',
          },
        }),
      ),
    );
    expect(selectBuildOutputContract(shell)).toBe('legacy-code-v1');
  });

  it('keeps direct writers direct', () => {
    const agent = capturedBackend(() =>
      createAgentImplementer(
        makeConfig({ implementer: { model: 'test', kind: 'agent', command: 'my-agent' } }),
      ),
    );
    expect(selectBuildOutputContract(agent)).toBe('direct');
  });

  it('keeps a configured custom command on its declared contract', () => {
    expect(selectBuildOutputContract({ extractsCode: true, backendKind: 'shell' })).toBe(
      'legacy-code-v1',
    );
    expect(selectBuildOutputContract({ extractsCode: false, backendKind: 'agent' })).toBe('direct');
  });

  it('defaults an extracted-output backend without a kind to legacy', () => {
    expect(selectBuildOutputContract({ extractsCode: true })).toBe('legacy-code-v1');
  });

  it('decides from the backend alone, so one-file and multi-file API briefs share the grammar', () => {
    expectTypeOf(selectBuildOutputContract).parameters.toEqualTypeOf<
      [{ extractsCode: boolean; backendKind?: ImplementerBaseConfig['backendKind'] | undefined }]
    >();
  });
});

describe('ImplementerResult.applyResult', () => {
  it('is optional, so existing results stay valid', () => {
    const legacy: ImplementerResult = { success: true, output: 'ok' };
    expect(legacy.applyResult).toBeUndefined();
    expectTypeOf<ImplementerResult['applyResult']>().toEqualTypeOf<BundleApplyResult | undefined>();
  });

  it('carries a partial apply without claiming success', () => {
    const applyResult: BundleApplyResult = {
      callId: 'implementer-1',
      candidatePaths: ['src/a.ts', 'src/b.ts'],
      status: 'partial',
      code: 'io-failure',
      error: 'EACCES',
      failedPath: 'src/b.ts',
      applied: [
        {
          path: 'src/a.ts',
          action: 'create',
          beforeSha256: null,
          afterSha256: 'abc',
          diff: '+x',
          linesAdded: 1,
          linesRemoved: 0,
        },
      ],
      noops: [],
      untouched: ['src/b.ts', 'src/c.ts'],
    };
    const result: ImplementerResult = { success: false, output: '', applyResult };
    expect(result.applyResult?.status).toBe('partial');
  });
});
