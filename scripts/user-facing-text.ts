import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Text a user may never read: admissions of untested work, internal process, and the
// ids and paths of how SPLITBRIEF is built. Each pattern is narrow enough that product
// vocabulary such as `unverified`, `owner-only` or `S3` passes.
const USER_FACING_MARKERS: readonly Readonly<{ label: string; pattern: RegExp }>[] = [
  { label: 'not verified live', pattern: /\bnot verified live\b/i },
  { label: 'untested', pattern: /\buntested\b/i },
  { label: 'captured live', pattern: /\bcaptured live\b/i },
  { label: 'no captured', pattern: /\bno captured\b/i },
  { label: 'known gaps', pattern: /\bknown gaps?\b/i },
  { label: '.nuke/ path', pattern: /\.nuke\// },
  { label: 'owner decision', pattern: /\bowner decision\b/i },
  { label: 'the owner', pattern: /\bthe owner\b(?!-)/i },
  { label: 'finding id', pattern: /\b(?:N|DOC|REL|CLR|WD)-\d+\b|\bS(?!3\b)\d{1,2}\b/ },
];

// An optional local term list, one term per line, kept out of the repository.
const LOCAL_TERMS = '.nuke/user-facing-terms.txt';

function localTermMarkers(root: string): { label: string; pattern: RegExp }[] {
  const file = join(root, LOCAL_TERMS);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((term) => term !== '')
    .map((term) => ({
      label: term,
      pattern: new RegExp(
        `(?<![-\\w.])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![-\\w])`,
        'i',
      ),
    }));
}

const MARKETPLACE = '.claude-plugin/marketplace.json';

const WEBSITE_COPY = [
  'docs/README.md',
  'website/index.html',
  'website/404.html',
  'website/docs/index.html',
  'website/site.json',
  'website/build/*.{ts,html}',
  'website/src/**/*.{ts,html}',
];

// The Claude Code plugin installs the skills its marketplace entry lists, and skills.sh installs
// every skill it finds that is not marked `metadata.internal: true`; their text is user-facing.
function installableSkillFiles(root: string): string[] {
  const marketplace: { plugins: { skills: string[] }[] } = JSON.parse(
    readFileSync(join(root, MARKETPLACE), 'utf8'),
  );
  const pluginDirs = marketplace.plugins.flatMap((plugin) =>
    plugin.skills.map((dir) => dir.replace(/^\.\//, '')),
  );
  const discoveredDirs = globSync(['skills/*/SKILL.md', '.claude/skills/*/SKILL.md'], { cwd: root })
    .filter((file) => !/^\s+internal:\s*true\s*$/m.test(readFileSync(join(root, file), 'utf8')))
    .map((file) => dirname(file));
  const skillDirs = [...new Set([...pluginDirs, ...discoveredDirs])];
  return [
    MARKETPLACE,
    ...globSync(
      skillDirs.map((dir) => `${dir}/**/*.md`),
      { cwd: root },
    ),
  ];
}

export function userFacingFiles(root: string = process.cwd()): string[] {
  const manifest: { files: string[] } = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  const shipped = manifest.files
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => entry.replace(/^\.\//, ''));
  const website = globSync(WEBSITE_COPY, { cwd: root, exclude: ['**/*.test.ts'] });
  return [...new Set([...shipped, ...website, ...installableSkillFiles(root)])].sort();
}

export function findUserFacingTextViolations(root: string = process.cwd()): string[] {
  const markers = [...USER_FACING_MARKERS, ...localTermMarkers(root)];
  return userFacingFiles(root).flatMap((file) =>
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        markers
          .filter(({ pattern }) => pattern.test(line))
          .map(({ label }) => `${file}:${index + 1}: ${label}`),
      ),
  );
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  for (const violation of findUserFacingTextViolations()) console.log(violation);
}
