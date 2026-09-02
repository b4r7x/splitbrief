import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../core/paths.js';
import { RETIRED_WORKFLOW_MODE_NOTICE } from '../core/schemas/enums.js';
import { resolveRunConfigWithBase } from './build-overrides.js';

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

describe('resolveRunConfigWithBase', () => {
  beforeEach(() => {
    tempDir = createTempDir('build-overrides-test');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    vi.restoreAllMocks();
  });

  itUnix('prints stable loader warnings once in non-interactive resolution', () => {
    const configPath = writeMinimalV3Config(tempDir);
    chmodSync(configPath, 0o666);
    const stderrChunks = captureStderr();

    resolveRunConfigWithBase({ projectDir: tempDir, opts: {} });

    const permissionWarnings = stderrChunks.filter((chunk) => chunk.includes('overly permissive'));
    expect(permissionWarnings).toHaveLength(1);
  });

  it('prints the retired-mode notice for a config file that still sets mode: instant', () => {
    writeMinimalV3Config(tempDir, ['workflow:', '  mode: instant']);
    const stderrChunks = captureStderr();

    const resolved = resolveRunConfigWithBase({ projectDir: tempDir, opts: {} });

    expect(resolved.config.workflow.mode).toBe('quick');
    expect(
      stderrChunks.filter((chunk) => chunk.includes(RETIRED_WORKFLOW_MODE_NOTICE)),
    ).toHaveLength(1);
  });

  it('returns the persistence snapshot from the load that produced the persisted config', () => {
    const configPath = writeMinimalV3Config(tempDir);
    const rawYaml = readFileSync(configPath, 'utf8');

    const resolved = resolveRunConfigWithBase({ projectDir: tempDir, opts: {} });

    expect(resolved.persistedConfig.workflow.mode).toBe('standard');
    expect(resolved.persistenceSnapshot.rawYaml).toBe(rawYaml);
    expect(resolved.persistenceSnapshot.rawBytes).toEqual(Buffer.from(rawYaml));
    expect(resolved.persistenceSnapshot.revision).not.toBeNull();
  });

  it('merges CLI overrides over the persisted config and falls back to defaultApprove', () => {
    writeMinimalV3Config(tempDir);

    const resolved = resolveRunConfigWithBase({
      projectDir: tempDir,
      opts: { mode: 'quick' },
      defaultApprove: 'all',
    });

    expect(resolved.config.workflow.mode).toBe('quick');
    expect(resolved.config.workflow.approve).toBe('all');
    expect(resolved.persistedConfig.workflow.mode).toBe('standard');
  });

  it('prefers an explicit approve option over defaultApprove', () => {
    writeMinimalV3Config(tempDir);

    const resolved = resolveRunConfigWithBase({
      projectDir: tempDir,
      opts: { approve: 'none' },
      defaultApprove: 'all',
    });

    expect(resolved.config.workflow.approve).toBe('none');
  });
});
