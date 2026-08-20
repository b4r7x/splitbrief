import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { configV3WriterHelperPath } from './helpers/run-config-v3-writer.js';

type ConfigDocumentEdit = {
  path: readonly string[];
  value: unknown;
};

type HelperOutput =
  | { kind: 'saved'; sha256: string }
  | { kind: 'loaded' }
  | { kind: 'error'; message: string };

type WriterIdentity = {
  label: 'current' | 'frozen';
  sourceRoot: string;
};

type SaveScenario = {
  label: 'settings' | 'runner';
  edits: ConfigDocumentEdit[];
  expectedHash: string;
};

type FrozenIdentityField = 'commit' | FrozenFilePath;

type FrozenManifestAdmission =
  | { kind: 'admitted' }
  | { kind: 'rejected'; field: FrozenIdentityField };

type BoundaryEvent =
  | { kind: 'identity-rejected'; field: FrozenIdentityField }
  | { kind: 'archive-invoked' }
  | { kind: 'helper-invoked' };

type HelperInvocation = {
  exitCode: number | null;
  output: HelperOutput;
};

type FrozenWriterResult =
  | { kind: 'rejected'; field: FrozenIdentityField }
  | { kind: 'invoked'; invocation: HelperInvocation };

type ScenarioEvidence = {
  identity: 'current' | 'frozen';
  scenario: 'settings' | 'runner';
  inputSha256: string;
  outputSha256: string;
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../..');
const helperPath = configV3WriterHelperPath;
const fixturePath = join(
  repositoryRoot,
  'testing',
  'fixtures',
  'configs',
  'v3-custom-commands-preservation.yaml',
);
const manifestPath = join(testDirectory, 'fixtures', 'v3-pre-change-writer.manifest.json');

const frozenFilePaths = [
  'src/core/config/load/io.ts',
  'src/lib/confined-fs.ts',
  'src/features/runners/config-transforms.ts',
  'src/stores/project/config-persistence.ts',
] as const;

type FrozenFilePath = (typeof frozenFilePaths)[number];

const frozenCommit = '7596ce1b8d3ab81e44b6432fdd3de954e58560f9';
const frozenFileSha256: Record<FrozenFilePath, string> = {
  'src/core/config/load/io.ts': '536d1c1d8383cd8720ab41673f2b153434924834a6a15bf15cf70e1d93951468',
  'src/lib/confined-fs.ts': '74717a5e3b4f20a08af549c35bcbd18bc7f0fa56a67b2863ec3e8b454c8f5cb0',
  'src/features/runners/config-transforms.ts':
    'a52f40beecf1fe95cda07f1c4ce142cf256d7c0793c402f50854746ac77e285d',
  'src/stores/project/config-persistence.ts':
    'd1033d22e11beef6c803338186d69ff364849c38aef783832dcec630ca1b105f',
};

const expectedInputHash = '35766e3b927d18e0fba44c23aa4105e3a178155532576342a5d1d9502afa1b60';
const expectedSettingsHash = 'b840b1f87c82b91e814975a83cf235bd416b4e53c673194667e828d944faea9a';
const expectedRunnerHash = '38195d15c681fc9abae3f429e45da6f788345301fc8af9395f97791dda42f379';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string.`);
  return value;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`Expected ${key} to be an object.`);
  return value;
}

function parseManifest(raw: string): FrozenManifestAdmission {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('The frozen-writer manifest must contain valid JSON.');
  }

  if (!isRecord(parsed)) throw new Error('The frozen-writer manifest must be an object.');
  const identity = readRecord(parsed, 'identity');
  const evidence = readRecord(parsed, 'evidence');
  const hashes = readRecord(parsed, 'sha256');

  if (readString(identity, 'packageName') !== 'splitbrief') {
    throw new Error('The frozen-writer manifest has the wrong package name.');
  }
  if (readString(identity, 'packageVersion') !== '0.1.0') {
    throw new Error('The frozen-writer manifest has the wrong package version.');
  }
  if (parsed['CONFIG_VERSION'] !== 3) {
    throw new Error('The frozen-writer manifest must record CONFIG_VERSION 3.');
  }
  if (readString(evidence, 'npmViewSplitbriefVersionsJson') !== 'E404') {
    throw new Error('The frozen-writer manifest must record the registry E404 evidence.');
  }
  if (!Array.isArray(evidence['repositoryTags']) || evidence['repositoryTags'].length !== 0) {
    throw new Error('The frozen-writer manifest must record zero repository tags.');
  }

  if (readString(identity, 'commit') !== frozenCommit) {
    return { kind: 'rejected', field: 'commit' };
  }

  for (const relativeFile of frozenFilePaths) {
    if (readString(hashes, relativeFile) !== frozenFileSha256[relativeFile]) {
      return { kind: 'rejected', field: relativeFile };
    }
  }

  return { kind: 'admitted' };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitOutput(args: readonly string[]): Buffer {
  return execFileSync('git', args, { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] });
}

function verifyFrozenIdentity(): void {
  execFileSync('git', ['cat-file', '-e', `${frozenCommit}^{commit}`], {
    cwd: repositoryRoot,
    stdio: 'pipe',
  });

  const frozenPackage = JSON.parse(gitOutput(['show', `${frozenCommit}:package.json`]).toString());
  if (!isRecord(frozenPackage)) throw new Error('The frozen package manifest must be an object.');
  expect(frozenPackage['name']).toBe('splitbrief');
  expect(frozenPackage['version']).toBe('0.1.0');
  expect(gitOutput(['tag', '--list']).toString().trim()).toBe('');
  expect(gitOutput(['show', `${frozenCommit}:src/core/schemas/config.ts`]).toString()).toContain(
    'export const CONFIG_VERSION = 3;',
  );

  for (const relativeFile of frozenFilePaths) {
    execFileSync('git', ['cat-file', '-e', `${frozenCommit}:${relativeFile}`], {
      cwd: repositoryRoot,
      stdio: 'pipe',
    });
    expect(sha256(gitOutput(['show', `${frozenCommit}:${relativeFile}`]))).toBe(
      frozenFileSha256[relativeFile],
    );
  }
}

async function archiveFrozenSource(
  sandboxRoot: string,
  archiveName: string,
  events: BoundaryEvent[],
): Promise<string> {
  events.push({ kind: 'archive-invoked' });
  const frozenRoot = join(sandboxRoot, 'frozen-source', archiveName);
  const archivePath = join(sandboxRoot, `${archiveName}.tar`);
  await mkdir(frozenRoot, { recursive: true });
  execFileSync('git', ['archive', '--format=tar', `--output=${archivePath}`, frozenCommit], {
    cwd: repositoryRoot,
    stdio: 'pipe',
  });
  execFileSync('tar', ['-xf', archivePath, '-C', frozenRoot], { stdio: 'pipe' });
  await symlink(join(repositoryRoot, 'node_modules'), join(frozenRoot, 'node_modules'), 'dir');
  return frozenRoot;
}

async function seedConfig(projectDir: string, rawYaml: string): Promise<string> {
  const configFile = join(projectDir, '.splitbrief', 'config.yaml');
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, rawYaml);
  return configFile;
}

function parseHelperOutput(raw: string): HelperOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Writer helper did not emit one JSON object: ${raw}`);
  }

  if (!isRecord(parsed)) throw new Error('Writer helper did not emit an object.');
  const kind = readString(parsed, 'kind');
  if (kind === 'saved') return { kind, sha256: readString(parsed, 'sha256') };
  if (kind === 'loaded') return { kind };
  if (kind === 'error') return { kind, message: readString(parsed, 'message') };
  throw new Error(`Writer helper emitted an unknown result kind: ${kind}`);
}

function isolatedNodeEnvironment(): NodeJS.ProcessEnv {
  const hostPath = process.env['PATH'];
  return hostPath === undefined ? {} : { PATH: hostPath };
}

function invokeHelper(
  sandboxRoot: string,
  identity: WriterIdentity,
  projectDir: string,
  rawYaml: string,
  edits: readonly ConfigDocumentEdit[],
  operation: 'write' | 'load',
  events?: BoundaryEvent[],
): { exitCode: number | null; output: HelperOutput } {
  events?.push({ kind: 'helper-invoked' });
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      helperPath,
      JSON.stringify({
        identityRoot: identity.sourceRoot,
        projectDir,
        rawYaml,
        edits,
        operation,
      }),
    ],
    {
      cwd: sandboxRoot,
      env: isolatedNodeEnvironment(),
      encoding: 'utf8',
    },
  );

  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) throw new Error(`Writer helper exited from signal ${result.signal}.`);
  if (result.stderr !== '') throw new Error(`Writer helper wrote stderr: ${result.stderr}`);

  return { exitCode: result.status, output: parseHelperOutput(result.stdout) };
}

async function invokeFrozenWriter(
  manifestRaw: string,
  sandboxRoot: string,
  archiveName: string,
  projectDir: string,
  rawYaml: string,
  edits: readonly ConfigDocumentEdit[],
  operation: 'write' | 'load',
  events: BoundaryEvent[],
): Promise<FrozenWriterResult> {
  const admission = parseManifest(manifestRaw);
  if (admission.kind === 'rejected') {
    events.push({ kind: 'identity-rejected', field: admission.field });
    return admission;
  }

  const sourceRoot = await archiveFrozenSource(sandboxRoot, archiveName, events);
  const invocation = invokeHelper(
    sandboxRoot,
    { label: 'frozen', sourceRoot },
    projectDir,
    rawYaml,
    edits,
    operation,
    events,
  );
  return { kind: 'invoked', invocation };
}

function preservedCustomCommandsBlock(rawYaml: string): string {
  const start = rawYaml.indexOf('customCommands:\n');
  const end = rawYaml.indexOf('planner:\n', start);
  if (start === -1 || end === -1)
    throw new Error('The fixture is missing its customCommands block.');
  return rawYaml.slice(start, end);
}

function expectPreservedYamlContext(
  written: string,
  customCommands: string,
  expectedVersion: number,
): void {
  expect(written.startsWith(`# preserve me\nversion: ${expectedVersion}\n`)).toBe(true);
  expect(written).toContain(customCommands);
  expect(written).toContain('unknownTop:\n  preserved: true\n');
  expect(written.endsWith('\n')).toBe(true);
  expect(written.indexOf('customCommands:')).toBeLessThan(written.indexOf('planner:'));
  expect(written.indexOf('planner:')).toBeLessThan(written.indexOf('implementer:'));
  expect(written.indexOf('implementer:')).toBeLessThan(written.indexOf('workflow:'));
}

async function hashWorktreeFiles(): Promise<Record<string, string>> {
  const entries = await Promise.all(
    frozenFilePaths.map(async (relativeFile) => [
      relativeFile,
      sha256(await readFile(join(repositoryRoot, relativeFile))),
    ]),
  );
  return Object.fromEntries(entries);
}

function driftOneCharacter(value: string): string {
  const lastCharacter = value.at(-1);
  if (lastCharacter === undefined) throw new Error('Cannot drift an empty identity value.');
  return `${value.slice(0, -1)}${lastCharacter === '0' ? '1' : '0'}`;
}

function driftManifestValue(rawManifest: string, value: string): string {
  const drifted = rawManifest.replace(value, driftOneCharacter(value));
  if (drifted === rawManifest)
    throw new Error('The expected frozen identity value was not in the manifest.');
  return drifted;
}

function printScenarioEvidence(record: ScenarioEvidence): void {
  console.info(JSON.stringify({ kind: 'v3-writer-evidence', ...record }));
}

const frozenIdentityDriftCases: Array<{
  label: string;
  field: FrozenIdentityField;
  value: string;
}> = [
  { label: 'commit', field: 'commit', value: frozenCommit },
  ...frozenFilePaths.map((relativeFile) => ({
    label: relativeFile,
    field: relativeFile,
    value: frozenFileSha256[relativeFile],
  })),
];

function expectFrozenInvocation(
  result: FrozenWriterResult,
  events: readonly BoundaryEvent[],
): HelperInvocation {
  expect(events).toEqual([{ kind: 'archive-invoked' }, { kind: 'helper-invoked' }]);
  if (result.kind === 'rejected') {
    throw new Error(`The frozen identity was unexpectedly rejected at ${result.field}.`);
  }
  return result.invocation;
}

describe('v3 custom command preservation', () => {
  it.each(frozenIdentityDriftCases)(
    'rejects a one-character $label manifest drift before archive or helper work',
    async ({ field, value }) => {
      const manifestRaw = await readFile(manifestPath, 'utf8');
      const events: BoundaryEvent[] = [];

      await withTempDir('splitbrief-v3-identity-drift', async (sandboxRoot) => {
        const result = await invokeFrozenWriter(
          driftManifestValue(manifestRaw, value),
          sandboxRoot,
          'rejected-identity',
          join(sandboxRoot, 'project'),
          '',
          [],
          'load',
          events,
        );

        expect(result).toEqual({ kind: 'rejected', field });
        expect(events).toEqual([{ kind: 'identity-rejected', field }]);
      });
    },
  );

  it('preserves the additive block through frozen and current unrelated document saves', async () => {
    const fixture = await readFile(fixturePath, 'utf8');
    const manifestRaw = await readFile(manifestPath, 'utf8');
    const manifestAdmission = parseManifest(manifestRaw);
    const customCommands = preservedCustomCommandsBlock(fixture);
    const scenarios: SaveScenario[] = [
      {
        label: 'settings',
        edits: [{ path: ['workflow', 'maxRetries'], value: 4 }],
        expectedHash: expectedSettingsHash,
      },
      {
        label: 'runner',
        edits: [
          { path: ['planner', 'kind'], value: 'cli' },
          { path: ['planner', 'tool'], value: 'codex' },
          { path: ['planner', 'model'], value: 'gpt-5.4' },
        ],
        expectedHash: expectedRunnerHash,
      },
    ];
    const evidence: ScenarioEvidence[] = [];

    expect(manifestAdmission).toEqual({ kind: 'admitted' });
    if (manifestAdmission.kind === 'rejected') {
      throw new Error(`The frozen identity was rejected at ${manifestAdmission.field}.`);
    }
    expect(sha256(fixture)).toBe(expectedInputHash);
    verifyFrozenIdentity();
    console.info(
      JSON.stringify({
        kind: 'writer-manifest',
        identity: 'frozen',
        commit: frozenCommit,
        sha256: frozenFileSha256,
      }),
    );
    console.info(
      JSON.stringify({
        kind: 'writer-manifest',
        identity: 'current',
        sha256: await hashWorktreeFiles(),
      }),
    );

    await withTempDir('splitbrief-v3-custom-commands', async (sandboxRoot) => {
      await symlink(join(repositoryRoot, 'node_modules'), join(sandboxRoot, 'node_modules'), 'dir');

      for (const identity of ['frozen', 'current'] as const) {
        for (const scenario of scenarios) {
          const projectDir = join(sandboxRoot, identity, scenario.label);
          const configFile = await seedConfig(projectDir, fixture);
          let invocation: HelperInvocation;

          if (identity === 'frozen') {
            const events: BoundaryEvent[] = [];
            const result = await invokeFrozenWriter(
              manifestRaw,
              sandboxRoot,
              `frozen-${scenario.label}`,
              projectDir,
              fixture,
              scenario.edits,
              'write',
              events,
            );
            invocation = expectFrozenInvocation(result, events);
          } else {
            invocation = invokeHelper(
              sandboxRoot,
              { label: 'current', sourceRoot: repositoryRoot },
              projectDir,
              fixture,
              scenario.edits,
              'write',
            );
          }

          expect(invocation.exitCode).toBe(0);
          expect(invocation.output).toEqual({ kind: 'saved', sha256: scenario.expectedHash });
          const written = await readFile(configFile, 'utf8');
          expect(sha256(written)).toBe(scenario.expectedHash);
          expectPreservedYamlContext(written, customCommands, 3);
          const record: ScenarioEvidence = {
            identity,
            scenario: scenario.label,
            inputSha256: expectedInputHash,
            outputSha256: scenario.expectedHash,
          };
          evidence.push(record);
          printScenarioEvidence(record);
        }

        const loadProjectDir = join(sandboxRoot, identity, 'load');
        const loadConfigFile = await seedConfig(loadProjectDir, fixture);
        let loaded: HelperInvocation;
        if (identity === 'frozen') {
          const events: BoundaryEvent[] = [];
          loaded = expectFrozenInvocation(
            await invokeFrozenWriter(
              manifestRaw,
              sandboxRoot,
              'frozen-load',
              loadProjectDir,
              fixture,
              [],
              'load',
              events,
            ),
            events,
          );
        } else {
          loaded = invokeHelper(
            sandboxRoot,
            { label: 'current', sourceRoot: repositoryRoot },
            loadProjectDir,
            fixture,
            [],
            'load',
          );
        }
        expect(loaded.exitCode).toBe(0);
        expect(loaded.output).toEqual({ kind: 'loaded' });
        expect(await readFile(loadConfigFile, 'utf8')).toBe(fixture);

        const unsupportedProjectDir = join(sandboxRoot, identity, 'unsupported');
        const unsupported = fixture.replace('version: 3\n', 'version: 4\n');
        const unsupportedConfigFile = await seedConfig(unsupportedProjectDir, unsupported);
        let rejected: HelperInvocation;
        if (identity === 'frozen') {
          const events: BoundaryEvent[] = [];
          rejected = expectFrozenInvocation(
            await invokeFrozenWriter(
              manifestRaw,
              sandboxRoot,
              'frozen-unsupported',
              unsupportedProjectDir,
              unsupported,
              [],
              'load',
              events,
            ),
            events,
          );
        } else {
          rejected = invokeHelper(
            sandboxRoot,
            { label: 'current', sourceRoot: repositoryRoot },
            unsupportedProjectDir,
            unsupported,
            [],
            'load',
          );
        }
        expect(rejected.exitCode).toBe(1);
        expect(rejected.output.kind).toBe('error');
        if (rejected.output.kind === 'error') {
          expect(rejected.output.message).toContain('Unsupported config version: 4');
        }
        const rejectedBytes = await readFile(unsupportedConfigFile, 'utf8');
        expect(rejectedBytes).toBe(unsupported);
        expectPreservedYamlContext(rejectedBytes, customCommands, 4);
      }
    });

    expect(evidence).toEqual([
      {
        identity: 'frozen',
        scenario: 'settings',
        inputSha256: expectedInputHash,
        outputSha256: expectedSettingsHash,
      },
      {
        identity: 'frozen',
        scenario: 'runner',
        inputSha256: expectedInputHash,
        outputSha256: expectedRunnerHash,
      },
      {
        identity: 'current',
        scenario: 'settings',
        inputSha256: expectedInputHash,
        outputSha256: expectedSettingsHash,
      },
      {
        identity: 'current',
        scenario: 'runner',
        inputSha256: expectedInputHash,
        outputSha256: expectedRunnerHash,
      },
    ]);
    console.info('v3 customCommands preservation: PASS');
  }, 60_000);
});
