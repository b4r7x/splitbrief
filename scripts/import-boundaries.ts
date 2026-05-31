import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface BoundaryViolation {
  file: string;
  specifier: string;
  reason: string;
}

const IMPORT_RE = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /import\s*['"]([^'"]+)['"]/g;

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const re of [IMPORT_RE, SIDE_EFFECT_IMPORT_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null = re.exec(source);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
      match = re.exec(source);
    }
  }
  return specifiers;
}

function srcRelative(srcRoot: string, absPath: string): string {
  return relative(srcRoot, absPath).split(sep).join('/');
}

function featureName(srcRelPath: string): string | null {
  const parts = srcRelPath.split('/');
  if (parts[0] !== 'features' || parts.length < 2) return null;
  return parts[1] ?? null;
}

function classify(fromSrcRel: string, targetSrcRel: string): string | null {
  const inComponents = fromSrcRel.startsWith('components/');
  const targetFeature = featureName(targetSrcRel);

  if (inComponents && targetFeature !== null) {
    return `src/components/** must not import from src/features/** (${targetFeature})`;
  }

  const fromFeature = featureName(fromSrcRel);
  if (fromFeature !== null && targetFeature !== null && fromFeature !== targetFeature) {
    return `src/features/${fromFeature}/** must not import from src/features/${targetFeature}/**`;
  }

  return null;
}

export function findImportBoundaryViolations(srcRoot: string): BoundaryViolation[] {
  const root = resolve(srcRoot);
  const violations: BoundaryViolation[] = [];

  for (const file of listSourceFiles(root)) {
    const source = readFileSync(file, 'utf-8');
    const fromSrcRel = srcRelative(root, file);

    for (const specifier of extractSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const targetAbs = resolve(dirname(file), specifier);
      if (!targetAbs.startsWith(root + sep)) continue;
      const targetSrcRel = srcRelative(root, targetAbs);
      const reason = classify(fromSrcRel, targetSrcRel);
      if (reason !== null) {
        violations.push({ file: fromSrcRel, specifier, reason });
      }
    }
  }

  return violations;
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const srcRoot = process.argv[2] ?? 'src';
  const violations = findImportBoundaryViolations(srcRoot);
  if (process.env.BOUNDARY_VERBOSE === '1') {
    for (const v of violations) {
      process.stderr.write(`${v.file} -> ${v.specifier}: ${v.reason}\n`);
    }
  }
  process.stdout.write(String(violations.length));
}
