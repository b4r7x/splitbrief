// Packed-install gate: check the npm tarball's contents, install it into an empty project
// under --engine-strict, load the native better-sqlite3 the installed package resolves, and
// run the installed `splitbrief` binary. Usage: node scripts/pack-install-smoke.mjs [tarball]
// Without a tarball it runs `npm pack`, whose `prepare` script rebuilds dist/ first.
// Installing a tarball does not run its `prepare`; dependency install scripts do run.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { tarballProblems } from './pack-contents.mjs';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'splitbrief-pack-smoke-'));

// Runs with `node` from PATH, the runtime npm and the `splitbrief` shebang use.
const NATIVE_PROBE = `
const Database = require('node:module').createRequire(process.argv[1])('better-sqlite3');
const db = new Database(':memory:');
const row = db.prepare('select 1 as x').get();
db.close();
if (row?.x !== 1) throw new Error('select 1 as x returned ' + JSON.stringify(row));
console.log(process.version + ' ' + process.platform + '-' + process.arch);
`;

function run(file, args, cwd, label = `${file} ${args.join(' ')}`) {
  try {
    return execFileSync(file, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    console.error(`FAIL: ${label} (exit ${error.status ?? error.signal})`);
    if (error.stdout) console.error(error.stdout);
    if (error.stderr) console.error(error.stderr);
    throw error;
  }
}

function packTarball() {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work], root));
  return join(work, packed[0].filename);
}

function checkContents(tarball) {
  const entries = run('tar', ['-tzf', tarball], work).split('\n').filter(Boolean);
  const packed = entries.includes('package/package.json')
    ? JSON.parse(run('tar', ['-xOzf', tarball, 'package/package.json'], work))
    : {};
  const problems = tarballProblems(entries, packed.files ?? []);
  if (problems.length > 0) {
    throw new Error(`${basename(tarball)} contents:\n  ${problems.join('\n  ')}`);
  }
}

try {
  const tarball = process.argv[2] ? resolve(process.argv[2]) : packTarball();
  checkContents(tarball);
  const project = join(work, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), '{ "name": "smoke", "private": true }\n');
  run('npm', ['install', '--no-audit', '--no-fund', '--engine-strict', tarball], project);

  const manifestPath = join(project, 'node_modules', 'splitbrief', 'package.json');
  const runtime = run(
    'node',
    ['-e', NATIVE_PROBE, manifestPath],
    project,
    'native better-sqlite3 does not load from the installed splitbrief',
  ).trim();

  const bin = join(project, 'node_modules', '.bin', 'splitbrief');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const version = run(bin, ['--version'], project).trim();
  if (version !== manifest.version) {
    throw new Error(
      `splitbrief --version printed '${version}', the package is ${manifest.version}`,
    );
  }
  const help = run(bin, ['--help'], project);
  if (!help.includes('Usage: splitbrief')) {
    throw new Error(`splitbrief --help printed no usage line:\n${help}`);
  }
  console.log(
    `ok — ${basename(tarball)} installs and runs splitbrief ${version} on node ${runtime} (native better-sqlite3 loads)`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
