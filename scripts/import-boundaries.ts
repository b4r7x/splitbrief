import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface BoundaryViolation {
  file: string;
  specifier: string;
  reason: string;
}

interface Reference {
  specifier: string;
  typeOnly: boolean;
}

const IMPORT_RE = /((?:import|export)[^'"]*?)from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /import\s*['"]([^'"]+)['"]/g;

const LAYER_RANK: Record<string, number> = {
  utils: 0,
  lib: 1,
  core: 2,
  engine: 3,
  stores: 3,
  features: 4,
  components: 4,
  hooks: 4,
  app: 5,
  cli: 5,
};

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

function extractReferences(source: string): Reference[] {
  const references: Reference[] = [];

  IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null = IMPORT_RE.exec(source);
  while (match !== null) {
    const head = match[1];
    const specifier = match[2];
    if (specifier !== undefined && head !== undefined) {
      references.push({ specifier, typeOnly: /^(?:import|export)\s+type\b/.test(head) });
    }
    match = IMPORT_RE.exec(source);
  }

  SIDE_EFFECT_IMPORT_RE.lastIndex = 0;
  match = SIDE_EFFECT_IMPORT_RE.exec(source);
  while (match !== null) {
    const specifier = match[1];
    if (specifier !== undefined) references.push({ specifier, typeOnly: false });
    match = SIDE_EFFECT_IMPORT_RE.exec(source);
  }

  return references;
}

function srcRelative(srcRoot: string, absPath: string): string {
  return relative(srcRoot, absPath).split(sep).join('/');
}

function featureName(srcRelPath: string): string | null {
  const parts = srcRelPath.split('/');
  if (parts[0] !== 'features' || parts.length < 2) return null;
  return parts[1] ?? null;
}

const ENGINE_FORBIDDEN_TOPLEVEL = ['hooks', 'components', 'cli'] as const;

function topLevelDir(srcRelPath: string): string | null {
  const parts = srcRelPath.split('/');
  return parts.length > 1 ? (parts[0] ?? null) : null;
}

function classify(fromSrcRel: string, targetSrcRel: string, typeOnly: boolean): string | null {
  const inComponents = fromSrcRel.startsWith('components/');
  const targetFeature = featureName(targetSrcRel);

  if (inComponents && targetFeature !== null) {
    return `src/components/** must not import from src/features/** (${targetFeature})`;
  }

  const fromFeature = featureName(fromSrcRel);
  if (fromFeature !== null && targetFeature !== null && fromFeature !== targetFeature) {
    return `src/features/${fromFeature}/** must not import from src/features/${targetFeature}/**`;
  }

  if (fromSrcRel.startsWith('engine/')) {
    const targetTop = topLevelDir(targetSrcRel);
    if (
      targetTop !== null &&
      (ENGINE_FORBIDDEN_TOPLEVEL as readonly string[]).includes(targetTop)
    ) {
      return `src/engine/** must not import from src/${targetTop}/**`;
    }
  }

  const fromTop = topLevelDir(fromSrcRel);
  const targetTop = topLevelDir(targetSrcRel);
  if (fromTop === null || targetTop === null || fromTop === targetTop) return null;

  const fromRank = LAYER_RANK[fromTop];
  const targetRank = LAYER_RANK[targetTop];
  if (fromRank === undefined || targetRank === undefined) return null;

  if (fromTop === 'stores' && targetTop === 'engine') {
    if (typeOnly) return null;
    return 'src/stores/** must not import from src/engine/** (type-only imports are the only sanctioned channel)';
  }

  if (targetRank > fromRank) {
    return `src/${fromTop}/** (layer rank ${fromRank}) must not import from src/${targetTop}/** (layer rank ${targetRank})`;
  }

  return null;
}

export function findImportBoundaryViolations(srcRoot: string): BoundaryViolation[] {
  const root = resolve(srcRoot);
  const violations: BoundaryViolation[] = [];

  for (const file of listSourceFiles(root)) {
    const source = readFileSync(file, 'utf-8');
    const fromSrcRel = srcRelative(root, file);

    for (const { specifier, typeOnly } of extractReferences(source)) {
      if (!specifier.startsWith('.')) continue;
      const targetAbs = resolve(dirname(file), specifier);
      if (!targetAbs.startsWith(root + sep)) continue;
      const targetSrcRel = srcRelative(root, targetAbs);
      const reason = classify(fromSrcRel, targetSrcRel, typeOnly);
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
