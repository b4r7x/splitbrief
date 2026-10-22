import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

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

// A warning shows on the feedback line and on stderr, so its label is user-facing text too: the
// argument that holds it, by the function that shows it.
const WARNING_LABEL_ARGUMENT: Readonly<Record<string, number>> = {
  warnError: 0,
  warnStderr: 0,
  readValidatedJson: 3,
};

const WARNING_LABEL_MARKERS: readonly Readonly<{ label: string; pattern: RegExp }>[] = [
  { label: 'module tag', pattern: /^[a-z][\w -]*: / },
  { label: 'camelCase name', pattern: /\b[a-z]+[A-Z]\w*/ },
  { label: 'call form', pattern: /\w\(/ },
];

// The words of a label as written: each interpolated value reads as `x`, so a tag built from a
// value (`${seat}-effort: `) still reads as a tag.
function labelText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `x${span.literal.text}`).join('');
  }
  return null;
}

export function findWarningLabelViolations(root: string = process.cwd()): string[] {
  const files = globSync('src/**/*.{ts,tsx}', { cwd: root, exclude: ['**/*.test.{ts,tsx}'] });
  return files.sort().flatMap((file) => {
    const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), {
      languageVersion: ts.ScriptTarget.Latest,
    });
    const violations: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const index = WARNING_LABEL_ARGUMENT[node.expression.text];
        const argument = index === undefined ? undefined : node.arguments[index];
        const text = argument === undefined ? null : labelText(argument);
        if (text !== null) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          for (const { label } of WARNING_LABEL_MARKERS.filter(({ pattern }) =>
            pattern.test(text),
          )) {
            violations.push(`${file}:${line}: warning label ${label}: ${text}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return violations;
  });
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  for (const violation of [...findUserFacingTextViolations(), ...findWarningLabelViolations()]) {
    console.log(violation);
  }
}
