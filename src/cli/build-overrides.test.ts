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

  itUnix('prints stable loader warnings once in non-interactive resolution', () => {
    const configPath = writeMinimalV3Config(tempDir);
    chmodSync(configPath, 0o666);
    const stderrChunks = captureStderr();

    resolveRunConfig({ projectDir: tempDir, opts: {} });

    const permissionWarnings = stderrChunks.filter((chunk) => chunk.includes('overly permissive'));
    expect(permissionWarnings).toHaveLength(1);
  });

  it('prints the retired workflow.mode notice once for a config file that still sets a mode', () => {
    writeMinimalV3Config(tempDir, ['workflow:', '  mode: instant']);
    const stderrChunks = captureStderr();

    resolveRunConfig({ projectDir: tempDir, opts: {} });

    expect(
      stderrChunks.filter((chunk) => chunk.includes('workflow.mode was retired')),
    ).toHaveLength(1);
  });

  it('tells the retired workflow.mode notice once when the screen already loaded the config', () => {
    writeMinimalV3Config(tempDir, ['workflow:', '  mode: instant']);
    const stderrChunks = captureStderr();

    configStore.load(tempDir);
    resolveRunConfig({ projectDir: tempDir, opts: {} });

    expect(
      stderrChunks.filter((chunk) => chunk.includes('workflow.mode was retired')),
    ).toHaveLength(1);
  });

  it('merges CLI overrides over the persisted config', () => {
    writeMinimalV3Config(tempDir);

    const config = resolveRunConfig({
      projectDir: tempDir,
      opts: { implementerModel: 'qwen3-coder:30b' },
    });

    expect(config.implementer).toMatchObject({ model: 'qwen3-coder:30b' });
  });
});
