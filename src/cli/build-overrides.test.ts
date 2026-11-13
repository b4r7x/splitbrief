import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../core/paths.js';
import { configStore } from '../stores/project/config.js';
import { resolveRunConfig } from './build-overrides.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

let tempDir: string;

function writeMinimalV3Config(projectDir: string, extraLines: readonly string[] = []): string {
  const filePath = join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
  mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(
    filePath,
    [
      'version: 3',
      'planner:',
      '  kind: cli',
      '  tool: claude-code',
      'implementer:',
      '  kind: api',
      '  provider: ollama',
      '  api_base: http://localhost:11434/v1',
      '  model: qwen2.5-coder:7b',
      ...extraLines,
    ].join('\n'),
  );
  return filePath;
}

function captureStderr(): string[] {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return chunks;
}

describe('resolveRunConfig', () => {
  beforeEach(() => {
    tempDir = createTempDir('build-overrides-test');
  });

  afterEach(() => {
    configStore.__testReset();
    cleanupTempDir(tempDir);
    vi.restoreAllMocks();
  });

  itUnix(
    'returns the loader warning of a non-interactive resolution and writes no stderr line',
    () => {
      const configPath = writeMinimalV3Config(tempDir);
      chmodSync(configPath, 0o666);
      const stderrChunks = captureStderr();

      const { warnings } = resolveRunConfig({ projectDir: tempDir, opts: {} });

      expect(warnings).toEqual([{ kind: 'config-file-permissions' }]);
      expect(stderrChunks).toEqual([]);
    },
  );

  it('returns the retired workflow.mode notice for a config file that still sets a mode and writes no stderr line', () => {
    writeMinimalV3Config(tempDir, ['workflow:', '  mode: instant']);
    const stderrChunks = captureStderr();

    const { warnings } = resolveRunConfig({ projectDir: tempDir, opts: {} });

    expect(warnings).toEqual([
      expect.objectContaining({
        kind: 'retired-value',
        notice: expect.stringContaining('workflow.mode was retired'),
      }),
    ]);
    expect(stderrChunks).toEqual([]);
  });

  it('returns the retired workflow.mode notice once when the screen already loaded the config, and writes no stderr line', () => {
    writeMinimalV3Config(tempDir, ['workflow:', '  mode: instant']);
    const stderrChunks = captureStderr();

    configStore.load(tempDir);
    const { warnings } = resolveRunConfig({ projectDir: tempDir, opts: {} });

    expect(warnings).toEqual([
      expect.objectContaining({
        kind: 'retired-value',
        notice: expect.stringContaining('workflow.mode was retired'),
      }),
    ]);
    expect(stderrChunks).toEqual([]);
  });

  it('merges CLI overrides over the persisted config', () => {
    writeMinimalV3Config(tempDir);

    const resolved = resolveRunConfig({
      projectDir: tempDir,
      opts: { implementerModel: 'qwen3-coder:30b' },
    });

    expect(resolved).toMatchObject({ config: { implementer: { model: 'qwen3-coder:30b' } } });
  });
});
