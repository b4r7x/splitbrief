import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliExecutableReceiptSchema } from '../../src/core/discovery/detection/executable.js';
import type { RunnerEvidence } from '../../src/core/discovery/runner-evidence.js';
import { CLI_TOOL_CATALOG } from '../../src/core/runners/cli-tool/catalog.js';
import type { Config } from '../../src/core/schemas/config.js';
import { runnerDiscoveryContextKey } from '../../src/engine/detection/context-key.js';
import { cleanupTempDir, createTempDir } from './temp-dir.js';

export const executable = CliExecutableReceiptSchema.parse({
  path: '/usr/local/bin/codex',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
  executableIdentity: {
    canonicalPath: '/usr/local/bin/codex',
    realPath: '/usr/local/bin/codex',
    platformFileId: '1:2',
    fingerprint: `1:2:3:4:sha256:${'a'.repeat(64)}`,
    resolvedAt: 1,
  },
});

const projectDirectories: string[] = [];

export function cleanupStartReadinessDirs(): void {
  for (const directory of projectDirectories.splice(0)) cleanupTempDir(directory);
}

export function projectWithConfig(config: Config): string {
  const projectDir = createTempDir('start-preparation');
  projectDirectories.push(projectDir);
  mkdirSync(join(projectDir, '.splitbrief'), { recursive: true });
  writeFileSync(join(projectDir, '.splitbrief', 'config.yaml'), JSON.stringify(config));
  return projectDir;
}

export function cliEvidence(
  context: Parameters<typeof runnerDiscoveryContextKey>[0],
): RunnerEvidence {
  const contextKey = runnerDiscoveryContextKey(context);
  const testedVersion = CLI_TOOL_CATALOG.codex.compatibility.testedVersion;
  return {
    runner: { id: 'codex', kind: 'cli', locality: 'local', enabled: 'enabled' },
    context: { key: contextKey, observedAt: 1, source: 'fresh' },
    installation: 'installed',
    executable: { kind: 'trusted', identity: executable.executableIdentity },
    compatibility: { kind: 'compatible', installedVersion: testedVersion, testedVersion },
    credential: 'present',
    auth: 'verified',
    endpoint: { kind: 'not-run' },
    catalog: { kind: 'not-run' },
    modelRun: {
      kind: 'unknown',
      selectionId: context.model ?? 'unselected',
      observedAt: 1,
      contextKey,
    },
  };
}
