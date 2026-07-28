import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const excludedComponents = new Set([
  '.git',
  '.nuke',
  'node_modules',
  'dist',
  'coverage',
  '.test-artifacts',
  'notes',
]);

const priorIdentityPatternSources = [['dip', 'tych'].join(''), ['tiny', 'spec'].join('[-_. ]?')];

const negativeMarker = ['// brand-contract', '-negative'].join('');

const firstPriorDisplay = ['Dip', 'tych'].join('');
const firstPriorMachine = ['dip', 'tych'].join('');
const firstPriorState = `.${firstPriorMachine}`;
const secondPriorMachine = ['tiny', 'spec'].join('-');
const secondPriorState = `.${secondPriorMachine}`;

const negativeContractLines = new Map<string, ReadonlySet<string>>([
  [
    'src/core/identity-contract.test.ts',
    new Set([
      `'${firstPriorState}', ${negativeMarker}`,
      `'${secondPriorState}', ${negativeMarker}`,
    ]),
  ],
  [
    'src/engine/runtime-hard-cut.test.ts',
    new Set([
      `'${firstPriorState}', ${negativeMarker}`,
      `'${secondPriorState}', ${negativeMarker}`,
      `'${firstPriorMachine.toUpperCase()}_CONTEXT_LENGTH', ${negativeMarker}`,
      `'${secondPriorMachine.replace('-', '_').toUpperCase()}_CONTEXT_LENGTH', ${negativeMarker}`,
      `'${firstPriorMachine}/legacy', ${negativeMarker}`,
      `'${secondPriorMachine}/legacy', ${negativeMarker}`,
    ]),
  ],
  [
    'testing/rebrand/maintained-tree-contract.test.ts',
    new Set([
      `{ kind: 'rejected', label: 'display', value: '${firstPriorDisplay}' }, ${negativeMarker}`,
      `{ kind: 'rejected', label: 'machine', value: '${firstPriorMachine}' }, ${negativeMarker}`,
      `{ kind: 'rejected', label: 'state', value: '${firstPriorState}/' }, ${negativeMarker}`,
      `{ kind: 'rejected', label: 'environment', value: '${firstPriorMachine.toUpperCase()}_API_KEY' }, ${negativeMarker}`,
      `{ kind: 'rejected', label: 'branch', value: '${firstPriorMachine}/example' }, ${negativeMarker}`,
      `{ kind: 'rejected', label: 'protocol', value: '${secondPriorMachine.replace('-', '.')}' }, ${negativeMarker}`,
    ]),
  ],
]);

interface BrandViolation {
  readonly path: string;
  readonly line?: number;
  readonly reason: string;
}

function listGitPaths(args: readonly string[]): string[] {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) throw result.error;
  const stderr = result.stderr.trim();
  if (result.status !== 0 || result.signal !== null || stderr.length > 0) {
    throw new Error(stderr || `git exited with ${result.status ?? result.signal}`);
  }

  return result.stdout.split('\0').filter((path) => path.length > 0);
}

function isExcluded(path: string): boolean {
  return path.split('/').some((component) => excludedComponents.has(component));
}

function isPresentFile(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isFile() || stats.isSymbolicLink();
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return false;
    throw cause;
  }
}

function collectMaintainedFiles(): string[] {
  const paths = listGitPaths(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);

  return paths.filter((path) => !isExcluded(path) && isPresentFile(path)).sort();
}

export function countPriorBrandMatches(value: string): number {
  return priorIdentityPatternSources.reduce((total, source) => {
    const matches = value.match(new RegExp(source, 'gi'));
    return total + (matches?.length ?? 0);
  }, 0);
}

function readMaintainedBytes(path: string): Buffer {
  if (lstatSync(path).isSymbolicLink()) {
    return Buffer.from(readlinkSync(path), 'utf8');
  }
  return readFileSync(path);
}

function inspectPath(path: string): BrandViolation[] {
  if (countPriorBrandMatches(path) === 0) return [];
  return [{ path, reason: 'prior identity appears in maintained path' }];
}

function inspectBytes(path: string, bytes: Buffer): BrandViolation[] {
  const violations: BrandViolation[] = [];
  const lines = bytes.toString('latin1').split('\n');
  const seenNegativeLines = new Set<string>();

  for (const [index, line] of lines.entries()) {
    const oldMatchCount = countPriorBrandMatches(line);
    const markerCount = line.split(negativeMarker).length - 1;

    if (markerCount > 0) {
      const normalizedLine = line.trim();
      const allowedLines = negativeContractLines.get(path);
      const validMarker =
        markerCount === 1 &&
        oldMatchCount === 1 &&
        allowedLines?.has(normalizedLine) === true &&
        !seenNegativeLines.has(normalizedLine);
      if (!validMarker) {
        violations.push({
          path,
          line: index + 1,
          reason: 'invalid brand-contract-negative marker',
        });
      } else {
        seenNegativeLines.add(normalizedLine);
      }
      continue;
    }

    if (oldMatchCount > 0) {
      violations.push({
        path,
        line: index + 1,
        reason: `${oldMatchCount} unsuppressed prior-identity match(es)`,
      });
    }
  }

  return violations;
}

function findBrandViolations(paths: readonly string[]): BrandViolation[] {
  return paths.flatMap((path) => [
    ...inspectPath(path),
    ...inspectBytes(path, readMaintainedBytes(path)),
  ]);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const violations = findBrandViolations(collectMaintainedFiles());
    if (violations.length === 0) {
      console.log('brand-contract: 0 violations');
    } else {
      for (const violation of violations) {
        const location =
          violation.line === undefined ? violation.path : `${violation.path}:${violation.line}`;
        console.error(`${location}: ${violation.reason}`);
      }
      console.error(`brand-contract: ${violations.length} violation(s)`);
      process.exitCode = 1;
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
