import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { PUBLIC_PATH, WEBSITE_ROOT } from './site.js';

export const THIRD_PARTY_NOTICES_PATH = resolve(PUBLIC_PATH, 'THIRD_PARTY_NOTICES.txt');

export const CLIENT_DISTRIBUTION_PACKAGES = [
  '@orama/orama',
  '@tanstack/history',
  '@tanstack/react-router',
  '@tanstack/react-start',
  '@tanstack/react-start-client',
  '@tanstack/react-store',
  '@tanstack/router-core',
  '@tanstack/start-client-core',
  '@tanstack/store',
  'bail',
  'compute-scroll-into-view',
  'cookie-es',
  'decode-named-character-reference',
  'extend',
  'fumadocs-core',
  'fumadocs-mdx',
  'github-slugger',
  'is-plain-obj',
  'longest-streak',
  'mdast-util-from-markdown',
  'mdast-util-phrasing',
  'mdast-util-to-markdown',
  'mdast-util-to-string',
  'micromark',
  'micromark-core-commonmark',
  'micromark-factory-destination',
  'micromark-factory-label',
  'micromark-factory-space',
  'micromark-factory-title',
  'micromark-factory-whitespace',
  'micromark-util-character',
  'micromark-util-chunked',
  'micromark-util-classify-character',
  'micromark-util-combine-extensions',
  'micromark-util-decode-numeric-character-reference',
  'micromark-util-decode-string',
  'micromark-util-html-tag-name',
  'micromark-util-normalize-identifier',
  'micromark-util-resolve-all',
  'micromark-util-subtokenize',
  'react',
  'react-dom',
  'remark',
  'remark-parse',
  'remark-stringify',
  'scheduler',
  'scroll-into-view-if-needed',
  'seroval',
  'seroval-plugins',
  'trough',
  'unified',
  'unist-util-is',
  'unist-util-stringify-position',
  'unist-util-visit',
  'unist-util-visit-parents',
  'use-sync-external-store',
  'vfile',
  'vfile-message',
  'zwitch',
] as const;

const lockEntrySchema = z
  .object({
    license: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
  })
  .passthrough();

const lockfileSchema = z.object({
  packages: z.record(z.string(), lockEntrySchema),
});

const packageManifestSchema = z
  .object({
    license: z.string().min(1),
    version: z.string().min(1),
  })
  .passthrough();

type PackageNotice = {
  readonly license: string;
  readonly legalFiles: readonly {
    readonly filename: string;
    readonly text: string;
  }[];
  readonly name: string;
  readonly version: string;
};

type NoticeGroup = {
  readonly entries: string[];
  readonly licenseText: string;
};

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

function normalizeLegalText(text: string): string {
  return text.replaceAll('\r\n', '\n').trimEnd();
}

async function packageNotice(
  packageName: (typeof CLIENT_DISTRIBUTION_PACKAGES)[number],
  lockPackages: z.infer<typeof lockfileSchema>['packages'],
): Promise<PackageNotice> {
  const packageDirectory = resolve(WEBSITE_ROOT, 'node_modules', packageName);
  const manifest = packageManifestSchema.parse(
    await readJson(resolve(packageDirectory, 'package.json')),
  );
  const lockEntry = lockPackages[`node_modules/${packageName}`];

  if (!lockEntry?.version || !lockEntry.license) {
    throw new Error(
      `${packageName} has no complete version and license record in package-lock.json`,
    );
  }
  if (lockEntry.version !== manifest.version || lockEntry.license !== manifest.license) {
    throw new Error(`${packageName} metadata differs between node_modules and package-lock.json`);
  }

  const legalFilenames = (await readdir(packageDirectory))
    .filter((filename) => /^(?:licen[cs]e|notice)(?:\.(?:md|txt))?$/i.test(filename))
    .sort();
  if (legalFilenames.length === 0) {
    throw new Error(`${packageName}@${manifest.version} does not ship a license or notice file`);
  }

  const legalFiles = await Promise.all(
    legalFilenames.map(async (filename) => ({
      filename,
      text: normalizeLegalText(await readFile(resolve(packageDirectory, filename), 'utf8')),
    })),
  );
  if (legalFiles.some(({ text }) => text.length === 0)) {
    throw new Error(`${packageName}@${manifest.version} ships an empty license or notice file`);
  }

  return {
    license: manifest.license,
    legalFiles,
    name: packageName,
    version: manifest.version,
  };
}

function groupedNotices(packages: readonly PackageNotice[]): NoticeGroup[] {
  const groups = new Map<string, string[]>();

  for (const packageDetails of packages) {
    for (const legalFile of packageDetails.legalFiles) {
      const entry = `${packageDetails.name}@${packageDetails.version} (${legalFile.filename})`;
      const entries = groups.get(legalFile.text) ?? [];
      entries.push(entry);
      groups.set(legalFile.text, entries);
    }
  }

  return [...groups.entries()]
    .map(([licenseText, entries]) => ({ entries: entries.sort(), licenseText }))
    .sort((left, right) => left.entries[0]?.localeCompare(right.entries[0] ?? '') ?? 0);
}

export async function buildThirdPartyNotices(): Promise<string> {
  const uniquePackageNames = new Set(CLIENT_DISTRIBUTION_PACKAGES);
  if (uniquePackageNames.size !== CLIENT_DISTRIBUTION_PACKAGES.length) {
    throw new Error('The browser-client package inventory contains duplicates');
  }

  const sortedPackageNames = [...CLIENT_DISTRIBUTION_PACKAGES].sort();
  if (
    sortedPackageNames.some(
      (packageName, index) => packageName !== CLIENT_DISTRIBUTION_PACKAGES[index],
    )
  ) {
    throw new Error('The browser-client package inventory must remain sorted');
  }

  const lockfile = lockfileSchema.parse(await readJson(resolve(WEBSITE_ROOT, 'package-lock.json')));
  const packages = await Promise.all(
    CLIENT_DISTRIBUTION_PACKAGES.map((packageName) =>
      packageNotice(packageName, lockfile.packages),
    ),
  );
  const inventory = packages
    .map(({ license, name, version }) => `- ${name}@${version} - ${license}`)
    .join('\n');
  const licenseSections = groupedNotices(packages)
    .map(
      ({ entries, licenseText }, index) =>
        `Notice ${index + 1}\n${'-'.repeat(`Notice ${index + 1}`.length)}\n` +
        `Packages: ${entries.join(', ')}\n\n${licenseText}`,
    )
    .join('\n\n');

  return `SPLITBRIEF Website Third-Party Notices
==========================================

This file covers the JavaScript packages present in the browser-client bundles. The reviewed
package inventory is maintained in scripts/third-party-notices.ts; generation validates every
version and SPDX license against package-lock.json and the installed package metadata.
Build-, test-, and server-only packages are excluded. Font licenses are shipped separately under
fonts/OFL-*.txt.

Regenerate with: npm run generate:licenses
Verify with:     npm run check:licenses

Bundled package inventory
-------------------------
${inventory}

License and notice texts
========================
${licenseSections}
`;
}

export async function thirdPartyNoticeViolations(): Promise<string[]> {
  const expected = await buildThirdPartyNotices();

  try {
    const actual = await readFile(THIRD_PARTY_NOTICES_PATH, 'utf8');
    return actual === expected
      ? []
      : ['public/THIRD_PARTY_NOTICES.txt is stale; run npm run generate:licenses'];
  } catch {
    return ['public/THIRD_PARTY_NOTICES.txt is missing; run npm run generate:licenses'];
  }
}
