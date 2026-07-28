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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = join(import.meta.dirname, '..', '..');
const scannerPath = join(projectRoot, 'scripts', 'check-brand.ts');
const tsxPath = join(projectRoot, 'node_modules', '.bin', 'tsx');
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
  return spawnSync(tsxPath, [scannerPath], {
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
  expectedMessage: string,
): void {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(expectedMessage);
  expect(result.stderr).toMatch(/brand-contract: [1-9]\d* violation\(s\)\n$/);
}

describe('brand scanner process boundary', () => {
  it('finds global paths and bytes while confining exclusions, markers, and symlinks', () => {
    sandboxRoot = mkdtempSync(join(tmpdir(), 'splitbrief-brand-scanner-'));
    const repo = join(sandboxRoot, 'repo');

    const clone = spawnSync('git', ['clone', '--quiet', projectRoot, repo], {
      encoding: 'utf8',
    });
    expect(clone.status).toBe(0);
    for (const entry of readdirSync(repo)) {
      if (entry !== '.git') rmSync(join(repo, entry), { recursive: true, force: true });
    }
    writeRepoFile(repo, 'README.md', 'SPLITBRIEF\n');
    expectScannerPass(runScanner(repo));

    writeRepoFile(repo, 'README.md', `${priorMachine}\n`);
    expectScannerFailure(runScanner(repo), 'README.md:1: 1 unsuppressed prior-identity match(es)');
    writeRepoFile(repo, 'README.md', 'SPLITBRIEF\n');

    const rejectedPath = `docs/${priorMachine}-guide.md`;
    writeRepoFile(repo, rejectedPath, 'SPLITBRIEF\n');
    expectScannerFailure(
      runScanner(repo),
      `${rejectedPath}: prior identity appears in maintained path`,
    );
    rmSync(join(repo, rejectedPath));

    writeRepoFile(repo, 'src/identity.ts', `export const name = '${priorDisplay}';\n`);
    expectScannerFailure(
      runScanner(repo),
      'src/identity.ts:1: 1 unsuppressed prior-identity match(es)',
    );
    rmSync(join(repo, 'src'), { recursive: true });

    writeRepoFile(repo, 'future-manifest.yaml', `name: ${priorMachine}\n`);
    expectScannerFailure(
      runScanner(repo),
      'future-manifest.yaml:1: 1 unsuppressed prior-identity match(es)',
    );
    rmSync(join(repo, 'future-manifest.yaml'));

    const negativeContractPath = 'testing/rebrand/maintained-tree-contract.test.ts';
    const validNegativeLine = `{ kind: 'rejected', label: 'display', value: '${priorDisplay}' }, ${negativeMarker}\n`;
    writeRepoFile(repo, negativeContractPath, validNegativeLine);
    expectScannerPass(runScanner(repo));

    writeRepoFile(
      repo,
      negativeContractPath,
      `const disguised = '${priorMachine}'; ${negativeMarker}\n`,
    );
    expectScannerFailure(
      runScanner(repo),
      `${negativeContractPath}:1: invalid brand-contract-negative marker`,
    );

    writeRepoFile(
      repo,
      negativeContractPath,
      `{ kind: 'rejected', label: 'machine', value: '${priorDisplay}' }, ${negativeMarker}\n`,
    );
    expectScannerFailure(
      runScanner(repo),
      `${negativeContractPath}:1: invalid brand-contract-negative marker`,
    );

    writeRepoFile(repo, negativeContractPath, validNegativeLine.repeat(2));
    expectScannerFailure(
      runScanner(repo),
      `${negativeContractPath}:2: invalid brand-contract-negative marker`,
    );
    rmSync(join(repo, 'testing'), { recursive: true });

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
    const visibleRuntimeState = runScanner(repo);
    expectScannerFailure(
      visibleRuntimeState,
      `${firstRuntimeState}: prior identity appears in maintained path`,
    );
    expect(visibleRuntimeState.stderr).toContain(
      `${secondRuntimeState}: prior identity appears in maintained path`,
    );

    appendFileSync(
      join(repo, '.git', 'info', 'exclude'),
      `\n.${priorMachine}/\n.${secondPriorMachine}/\n`,
    );
    expectScannerPass(runScanner(repo));

    writeRepoFile(repo, 'workspace/notes-extra/brand.txt', `${priorMachine}\n`);
    expectScannerFailure(
      runScanner(repo),
      'workspace/notes-extra/brand.txt:1: 1 unsuppressed prior-identity match(es)',
    );
    rmSync(join(repo, 'workspace', 'notes-extra'), { recursive: true });

    const outsideFile = join(sandboxRoot, 'outside.txt');
    writeFileSync(outsideFile, `${priorMachine}\n`);
    symlinkSync(outsideFile, join(repo, 'linked.txt'));
    expectScannerPass(runScanner(repo));

    const rejectedLink = `${priorMachine}-link`;
    symlinkSync(outsideFile, join(repo, rejectedLink));
    expectScannerFailure(
      runScanner(repo),
      `${rejectedLink}: prior identity appears in maintained path`,
    );
    rmSync(join(repo, rejectedLink));

    const brokenLink = 'broken-link';
    symlinkSync(join(sandboxRoot, `${priorMachine}-missing.txt`), join(repo, brokenLink));
    expectScannerFailure(
      runScanner(repo),
      `${brokenLink}:1: 1 unsuppressed prior-identity match(es)`,
    );
    rmSync(join(repo, brokenLink));

    const rejectedBrokenLink = `${priorMachine}-broken-link`;
    symlinkSync(join(sandboxRoot, 'missing.txt'), join(repo, rejectedBrokenLink));
    expectScannerFailure(
      runScanner(repo),
      `${rejectedBrokenLink}: prior identity appears in maintained path`,
    );
  }, 30_000);
});
