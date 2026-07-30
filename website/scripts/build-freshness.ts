import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEBSITE_ROOT } from './site.js';

const DEFAULT_INPUTS = [
  'content',
  'package-lock.json',
  'package.json',
  'public',
  'scripts',
  'shared',
  'source.config.ts',
  'src',
  'tsconfig.json',
  'vite.config.ts',
] as const;
type BuildFreshnessOptions = {
  readonly inputPaths?: readonly string[];
  readonly siteUrl?: string;
  readonly stampPath?: string;
  readonly websiteRoot?: string;
};

async function inputFiles(path: string): Promise<string[]> {
  const details = await stat(path);
  if (details.isFile()) {
    return [path];
  }
  if (!details.isDirectory()) {
    throw new Error(`Build input is neither a file nor a directory: ${path}`);
  }

  const entries = await readdir(path, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => inputFiles(resolve(path, entry.name))),
  );
  return nestedFiles.flat();
}

export async function buildInputDigest({
  inputPaths = DEFAULT_INPUTS,
  siteUrl = process.env.SITE_URL ?? '',
  websiteRoot = WEBSITE_ROOT,
}: BuildFreshnessOptions = {}): Promise<string> {
  const absoluteInputs = inputPaths.map((path) => resolve(websiteRoot, path));
  const files = (await Promise.all(absoluteInputs.map(inputFiles))).flat().sort();
  const digest = createHash('sha256');
  digest.update('SITE_URL\0');
  digest.update(String(Buffer.byteLength(siteUrl)));
  digest.update('\0');
  digest.update(siteUrl);

  for (const path of files) {
    const contents = await readFile(path);
    digest.update(relative(websiteRoot, path));
    digest.update('\0');
    digest.update(String(contents.byteLength));
    digest.update('\0');
    digest.update(contents);
  }

  return digest.digest('hex');
}

export async function invalidateBuildFreshness({
  stampPath,
  websiteRoot = WEBSITE_ROOT,
}: BuildFreshnessOptions = {}): Promise<void> {
  await rm(stampPath ?? resolve(websiteRoot, 'dist/build-inputs.sha256'), { force: true });
}

export async function recordBuildFreshness({
  stampPath,
  websiteRoot = WEBSITE_ROOT,
  ...options
}: BuildFreshnessOptions = {}): Promise<void> {
  const resolvedStampPath = stampPath ?? resolve(websiteRoot, 'dist/build-inputs.sha256');
  const digest = await buildInputDigest({ ...options, websiteRoot });
  await mkdir(dirname(resolvedStampPath), { recursive: true });
  await writeFile(resolvedStampPath, `${digest}\n`);
}

export async function checkBuildFreshness({
  stampPath,
  websiteRoot = WEBSITE_ROOT,
  ...options
}: BuildFreshnessOptions = {}): Promise<void> {
  const resolvedStampPath = stampPath ?? resolve(websiteRoot, 'dist/build-inputs.sha256');
  let recordedDigest: string;
  try {
    recordedDigest = (await readFile(resolvedStampPath, 'utf8')).trim();
  } catch {
    throw new Error('Built output has no freshness stamp. Run npm run build first.');
  }

  const currentDigest = await buildInputDigest({ ...options, websiteRoot });
  if (recordedDigest !== currentDigest) {
    throw new Error('Built output is stale. Run npm run build again.');
  }
}

const entryPath = process.argv[1];
if (entryPath && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  const command = process.argv[2];
  if (command === 'clear') {
    await invalidateBuildFreshness();
    process.stdout.write('Built output freshness: invalidated\n');
  } else if (command === 'record') {
    await recordBuildFreshness();
    process.stdout.write('Built output freshness: recorded\n');
  } else if (command === 'check') {
    await checkBuildFreshness();
    process.stdout.write('Built output freshness: verified\n');
  } else {
    throw new Error('Usage: tsx scripts/build-freshness.ts <clear|record|check>');
  }
}
