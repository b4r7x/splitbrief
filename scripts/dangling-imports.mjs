import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const tracked = execFileSync(
  'git',
  ['ls-files', '-co', '--exclude-standard', 'src', 'testing', 'scripts'],
  { encoding: 'utf-8' },
);
const files = tracked.split('\n').filter((f) => /\.(ts|tsx|mts)$/.test(f) && existsSync(f));

// Real import/export statements only: must start the line (optionally indented by nothing).
const IMPORT =
  /^(?:import|export)\b[^;]*?from\s*['"](\.[^'"]+)['"]|(?:await\s+)?import\(\s*['"](\.[^'"]+)['"]\s*\)/gm;
const dangling = [];

for (const file of files) {
  const src = readFileSync(file, 'utf-8');
  for (const m of src.matchAll(IMPORT)) {
    // A line that opens with a quote is a string literal holding example code, not an
    // import: fixtures and generated scripts embed import statements as text.
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (/^\s*["']/.test(src.slice(lineStart, m.index + 1))) continue;
    // An odd number of backticks before the match means it sits inside a template
    // literal — prompt templates embed example import statements as prose.
    if ((src.slice(0, m.index).match(/`/g)?.length ?? 0) % 2 === 1) continue;
    const spec = m[1] ?? m[2];
    const base = resolve(dirname(file), spec);
    const cands = spec.endsWith('.js')
      ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base]
      : [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
    if (cands.some((c) => existsSync(c) && statSync(c).isFile())) continue;
    dangling.push({ file, line: src.slice(0, m.index).split('\n').length, spec });
  }
}

if (dangling.length === 0) {
  console.log(`clean — ${files.length} files scanned`);
} else {
  const fileCount = new Set(dangling.map((d) => d.file)).size;
  console.log(
    `${dangling.length} dangling import(s) in ${fileCount} file(s) of ${files.length} scanned:\n`,
  );
  for (const d of dangling) console.log(`  ${d.file}:${d.line} -> ${d.spec}`);
  process.exitCode = 1;
}
