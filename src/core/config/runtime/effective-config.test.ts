import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { formatConfigLoaderDiagnostic } from '../load/io.js';
import { createDefaultConfig } from '../load/defaults.js';
import type { ConfigLoaderDiagnostic } from '../load/io.js';
import { emitEffectiveConfigWarnings, resolveEffectiveConfig } from './effective-config.js';

describe('resolveEffectiveConfig', () => {
  it('rejects {prompt} in a command runner argument', () => {
    const base = {
      ...createDefaultConfig(),
      implementer: {
        kind: 'shell' as const,
        command: 'local-implementer',
        args: ['--prompt', '{prompt}'],
        model: 'custom-model',
      },
    };

    expect(() => resolveEffectiveConfig({ base })).toThrow(
      '{prompt} is not supported; SPLITBRIEF sends the prompt on stdin',
    );
  });

  it('returns the loader diagnostics as its warnings after an override', () => {
    const { config, warnings } = resolveEffectiveConfig({
      base: makeConfig(),
      overrides: {
        implementer: {
          tool: 'ollama',
          model: 'qwen2.5-coder:7b',
          apiBase: 'http://localhost:11434/v1',
        },
      },
      loaderDiagnostics: [{ kind: 'config-file-permissions' }],
    });

    expect(config.implementer).toMatchObject({ kind: 'api', provider: 'ollama' });
    expect(warnings).toEqual([{ kind: 'config-file-permissions' }]);
  });

  it('rejects invalid overrides after merge', () => {
    const base = createDefaultConfig();
    expect(() =>
      resolveEffectiveConfig({
        base,
        overrides: { contextLength: -1 },
      }),
    ).toThrow(/contextLength/);
  });

  it('applies implementer model override before validation', () => {
    const base = createDefaultConfig();
    const { config } = resolveEffectiveConfig({
      base,
      overrides: { implementer: { model: 'deepseek-chat' } },
    });

    expect(config.implementer).toMatchObject({ model: 'deepseek-chat' });
  });
});

describe('emitEffectiveConfigWarnings', () => {
  let stderrChunks: string[];

  beforeEach(() => {
    stderrChunks = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes each effective-config warning to stderr so the detached server log surfaces it', () => {
    emitEffectiveConfigWarnings('/work/each', [
      { kind: 'config-file-permissions' },
      { kind: 'retired-value', notice: 'workflow.task_review was retired.' },
    ]);

    const written = stderrChunks.join('');
    expect(written).toContain(
      "⚠ The file's group or other users can change .splitbrief/config.yaml.",
    );
    expect(written).toContain('⚠ workflow.task_review was retired.');
  });

  it('prints a repeated notice once', () => {
    const diagnostic = { kind: 'config-file-permissions' } satisfies ConfigLoaderDiagnostic;
    const message = formatConfigLoaderDiagnostic(diagnostic);

    emitEffectiveConfigWarnings('/work/matching', [diagnostic, diagnostic]);

    expect(stderrChunks.filter((chunk) => chunk.includes(message))).toHaveLength(1);
  });

  it("tells a project's notice once a process and another project's notice again", () => {
    const warnings = [
      { kind: 'retired-value', notice: 'workflow.mode was retired.' },
    ] satisfies ConfigLoaderDiagnostic[];

    emitEffectiveConfigWarnings('/work/one', warnings);
    emitEffectiveConfigWarnings('/work/one', warnings);
    emitEffectiveConfigWarnings('/work/two', warnings);

    expect(stderrChunks.filter((chunk) => chunk.includes('workflow.mode was retired.'))).toEqual([
      '⚠ workflow.mode was retired.\n',
      '⚠ workflow.mode was retired.\n',
    ]);
  });

  it('writes nothing when there are no warnings', () => {
    emitEffectiveConfigWarnings('/work/none', []);

    expect(stderrChunks.join('')).toBe('');
  });
});
