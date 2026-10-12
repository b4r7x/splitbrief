import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
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

type FrozenManifestAdmission = { kind: 'admitted' } | { kind: 'rejected'; field: string };

type BoundaryEvent = { kind: 'identity-rejected'; field: string } | { kind: 'helper-invoked' };

type HelperInvocation = {
  exitCode: number | null;
  output: HelperOutput;
};

type FrozenWriterResult =
  | { kind: 'rejected'; field: string }
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
const frozenSourceRoot = join(testDirectory, 'fixtures', 'v3-pre-change-writer');

const writerRootFilePaths = [
  'src/core/config/load/io.ts',
  'src/lib/confined-fs.ts',
  'src/features/runners/config-transforms.ts',
  'src/stores/project/config-persistence.ts',
] as const;

const vendoredSha256 = await hashVendoredFiles();

const expectedInputHash = 'ed0a8fe275b2f1a7b0761589cc34ef35bb85d76821366b278ea90f53f4a879ae';
const expectedSettingsHash = '54bba5345211836a61b6f045e47b62d5d593c10447eb6d26e3be280f2bb33fd9';
const expectedRunnerHash = '2027d53aa1cd9d219c2fc2e2003f4c5d0be2626f826264945c43cb47286f27ff';

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
  if (Object.keys(parsed).toSorted().join() !== 'CONFIG_VERSION,sha256') {
    throw new Error('The frozen-writer manifest must hold only CONFIG_VERSION and sha256.');
  }
  const hashes = readRecord(parsed, 'sha256');

  if (parsed['CONFIG_VERSION'] !== 3) {
    throw new Error('The frozen-writer manifest must record CONFIG_VERSION 3.');
  }
  if (Object.keys(hashes).toSorted().join('\n') !== Object.keys(vendoredSha256).join('\n')) {
    throw new Error('The frozen-writer manifest must list exactly the vendored files.');
  }

  for (const [relativeFile, actual] of Object.entries(vendoredSha256)) {
    if (readString(hashes, relativeFile) !== actual) {
      return { kind: 'rejected', field: relativeFile };
    }
  }

  return { kind: 'admitted' };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function hashVendoredFiles(): Promise<Record<string, string>> {
  const vendoredFiles = (await readdir(frozenSourceRoot, { recursive: true, withFileTypes: true }))
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(frozenSourceRoot, join(entry.parentPath, entry.name)))
    .toSorted();
  const entries = await Promise.all(
    vendoredFiles.map(async (relativeFile) => [
      relativeFile,
      sha256(await readFile(join(frozenSourceRoot, relativeFile))),
    ]),
  );
  return Object.fromEntries(entries);
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

function invokeFrozenWriter(
  manifestRaw: string,
  sandboxRoot: string,
  projectDir: string,
  rawYaml: string,
  edits: readonly ConfigDocumentEdit[],
  operation: 'write' | 'load',
  events: BoundaryEvent[],
): FrozenWriterResult {
  const admission = parseManifest(manifestRaw);
  if (admission.kind === 'rejected') {
    events.push({ kind: 'identity-rejected', field: admission.field });
    return admission;
  }

  const invocation = invokeHelper(
    sandboxRoot,
    { label: 'frozen', sourceRoot: frozenSourceRoot },
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
    writerRootFilePaths.map(async (relativeFile) => [
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

const frozenIdentityDriftCases = Object.entries(vendoredSha256).map(([field, value]) => ({
  field,
  value,
}));

function expectFrozenInvocation(
  result: FrozenWriterResult,
  events: readonly BoundaryEvent[],
): HelperInvocation {
  expect(events).toEqual([{ kind: 'helper-invoked' }]);
  if (result.kind === 'rejected') {
    throw new Error(`The frozen identity was unexpectedly rejected at ${result.field}.`);
  }
  return result.invocation;
}

describe('v3 custom command preservation', () => {
  it.each(frozenIdentityDriftCases)(
    'rejects a one-character $field manifest drift before helper work',
    async ({ field, value }) => {
      const manifestRaw = await readFile(manifestPath, 'utf8');
      const events: BoundaryEvent[] = [];

      await withTempDir('splitbrief-v3-identity-drift', async (sandboxRoot) => {
        const result = invokeFrozenWriter(
          driftManifestValue(manifestRaw, value),
          sandboxRoot,
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
    expect(await readFile(join(frozenSourceRoot, 'src/core/schemas/config.ts'), 'utf8')).toContain(
      'export const CONFIG_VERSION = 3;',
    );
    console.info(
      JSON.stringify({
        kind: 'writer-manifest',
        identity: 'frozen',
        sha256: vendoredSha256,
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
            const result = invokeFrozenWriter(
              manifestRaw,
              sandboxRoot,
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
            invokeFrozenWriter(
              manifestRaw,
              sandboxRoot,
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
            invokeFrozenWriter(
              manifestRaw,
              sandboxRoot,
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
