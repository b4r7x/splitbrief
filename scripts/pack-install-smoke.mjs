// Packed-install gate: install the npm tarball into an empty project and run the
// installed `splitbrief` binary. Usage: node scripts/pack-install-smoke.mjs [tarball]
// Without a tarball it runs `npm pack`, whose `prepare` script rebuilds dist/ first.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'splitbrief-pack-smoke-'));

function run(file, args, cwd) {
  try {
    return execFileSync(file, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    console.error(`FAIL: ${file} ${args.join(' ')} (exit ${error.status ?? error.signal})`);
    if (error.stdout) console.error(error.stdout);
    if (error.stderr) console.error(error.stderr);
    throw error;
  }
}

function packTarball() {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work], root));
  return join(work, packed[0].filename);
}

try {
  const tarball = process.argv[2] ? resolve(process.argv[2]) : packTarball();
  const project = join(work, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), '{ "name": "smoke", "private": true }\n');
  run('npm', ['install', '--no-audit', '--no-fund', tarball], project);

  const bin = join(project, 'node_modules', '.bin', 'splitbrief');
  const manifest = JSON.parse(
    readFileSync(join(project, 'node_modules', 'splitbrief', 'package.json'), 'utf-8'),
  );
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
  console.log(`ok — ${basename(tarball)} installs and runs splitbrief ${version}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
