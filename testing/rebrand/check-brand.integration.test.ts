import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestGitRepo } from '#testing/helpers/git.js';

const projectRoot = join(import.meta.dirname, '..', '..');
const scannerPath = join(projectRoot, 'scripts', 'check-brand.ts');
// Node with the tsx loader, not the tsx CLI: the CLI starts a second Node process on every run.
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
const priorDisplay = ['Dip', 'tych'].join('');
const priorMachine = ['dip', 'tych'].join('');
const secondPriorMachine = ['tiny', 'spec'].join('-');
const negativeMarker = ['// brand-contract', '-negative'].join('');

let sandboxRoot: string | undefined;

afterEach(() => {
  if (sandboxRoot !== undefined) rmSync(sandboxRoot, { recursive: true, force: true });
  sandboxRoot = undefined;
});

function writeRepoFile(repo: string, path: string, content: string): void {
  const absolutePath = join(repo, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function runScanner(repo: string) {
  return spawnSync(process.execPath, ['--import', tsxLoader, scannerPath], {
    cwd: repo,
    encoding: 'utf8',
  });
}

function expectScannerPass(result: ReturnType<typeof runScanner>): void {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('brand-contract: 0 violations\n');
  expect(result.stderr).toBe('');
}

function expectScannerFailure(
  result: ReturnType<typeof runScanner>,
  expectedViolations: readonly string[],
): void {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  const lines = result.stderr.split('\n');
  expect(lines.pop()).toBe('');
  expect(lines.pop()).toBe(`brand-contract: ${expectedViolations.length} violation(s)`);
  expect(lines.toSorted()).toEqual([...expectedViolations].toSorted());
}

describe('brand scanner process boundary', () => {
  it('finds global paths and bytes while confining exclusions, markers, and symlinks', () => {
    sandboxRoot = mkdtempSync(join(tmpdir(), 'splitbrief-brand-scanner-'));
    const repo = join(sandboxRoot, 'repo');

    mkdirSync(repo);
    createTestGitRepo(repo);
    for (const entry of readdirSync(repo)) {
      if (entry !== '.git') rmSync(join(repo, entry), { recursive: true, force: true });
    }
    writeRepoFile(repo, 'README.md', 'SPLITBRIEF\n');
    expectScannerPass(runScanner(repo));

    // Each scanner run starts Node, which is most of this test's time on a loaded machine, so
    // one run checks many independent files. The exact violation list proves what is caught
    // and that nothing else is.
    writeRepoFile(repo, 'README.md', `${priorMachine}\n`);
    const rejectedPath = `docs/${priorMachine}-guide.md`;
    writeRepoFile(repo, rejectedPath, 'SPLITBRIEF\n');
    writeRepoFile(repo, 'src/identity.ts', `export const name = '${priorDisplay}';\n`);
    writeRepoFile(repo, 'future-manifest.yaml', `name: ${priorMachine}\n`);

    const negativeContractPath = 'testing/rebrand/maintained-tree-contract.test.ts';
    const validNegativeLine = `{ kind: 'rejected', label: 'display', value: '${priorDisplay}' }, ${negativeMarker}\n`;
    writeRepoFile(
      repo,
      negativeContractPath,
      [
        validNegativeLine,
        `const disguised = '${priorMachine}'; ${negativeMarker}\n`,
        `{ kind: 'rejected', label: 'machine', value: '${priorDisplay}' }, ${negativeMarker}\n`,
        validNegativeLine,
      ].join(''),
    );

    for (const component of [
      '.git',
      '.nuke',
      'node_modules',
      'dist',
      'coverage',
      '.test-artifacts',
      'notes',
    ]) {
      const excludedPath =
        component === '.git' ? '.git/brand.txt' : `workspace/${component}/brand.txt`;
      writeRepoFile(repo, excludedPath, `${priorMachine}\n`);
    }
    const firstRuntimeState = `.${priorMachine}/state.json`;
    const secondRuntimeState = `.${secondPriorMachine}/state.json`;
    writeRepoFile(repo, firstRuntimeState, priorMachine);
    writeRepoFile(repo, secondRuntimeState, secondPriorMachine);
    expectScannerFailure(runScanner(repo), [
      'README.md:1: 1 unsuppressed prior-identity match(es)',
      `${rejectedPath}: prior identity appears in maintained path`,
      'src/identity.ts:1: 1 unsuppressed prior-identity match(es)',
      'future-manifest.yaml:1: 1 unsuppressed prior-identity match(es)',
      `${negativeContractPath}:2: invalid brand-contract-negative marker`,
      `${negativeContractPath}:3: invalid brand-contract-negative marker`,
      `${negativeContractPath}:4: invalid brand-contract-negative marker`,
      `${firstRuntimeState}: prior identity appears in maintained path`,
      `${firstRuntimeState}:1: 1 unsuppressed prior-identity match(es)`,
      `${secondRuntimeState}: prior identity appears in maintained path`,
      `${secondRuntimeState}:1: 1 unsuppressed prior-identity match(es)`,
    ]);
    writeRepoFile(repo, 'README.md', 'SPLITBRIEF\n');
    rmSync(join(repo, 'docs'), { recursive: true });
    rmSync(join(repo, 'src'), { recursive: true });
    rmSync(join(repo, 'future-manifest.yaml'));
    rmSync(join(repo, 'testing'), { recursive: true });

    appendFileSync(
      join(repo, '.git', 'info', 'exclude'),
      `\n.${priorMachine}/\n.${secondPriorMachine}/\n`,
    );
    writeRepoFile(repo, 'workspace/notes-extra/brand.txt', `${priorMachine}\n`);
    const outsideFile = join(sandboxRoot, 'outside.txt');
    writeFileSync(outsideFile, `${priorMachine}\n`);
    symlinkSync(outsideFile, join(repo, 'linked.txt'));
    const rejectedLink = `${priorMachine}-link`;
    symlinkSync(outsideFile, join(repo, rejectedLink));
    const brokenLink = 'broken-link';
    symlinkSync(join(sandboxRoot, `${priorMachine}-missing.txt`), join(repo, brokenLink));
    const rejectedBrokenLink = `${priorMachine}-broken-link`;
    symlinkSync(join(sandboxRoot, 'missing.txt'), join(repo, rejectedBrokenLink));
    expectScannerFailure(runScanner(repo), [
      'workspace/notes-extra/brand.txt:1: 1 unsuppressed prior-identity match(es)',
      `${rejectedLink}: prior identity appears in maintained path`,
      `${brokenLink}:1: 1 unsuppressed prior-identity match(es)`,
      `${rejectedBrokenLink}: prior identity appears in maintained path`,
    ]);
  }, 30_000);
});
