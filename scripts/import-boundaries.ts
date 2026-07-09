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

type Slice =
  | { readonly kind: 'feature'; readonly name: string } // src/features/<name>/**         (folder slice)
  | { readonly kind: 'screen'; readonly name: string } //  src/app/screens/<name>.tsx     (flat page)
  | { readonly kind: 'overlay'; readonly name: string }; // src/app/overlays/<name>.tsx    (flat page)

const SLICE_EXT_RE = /\.(?:ts|tsx|js|jsx)$/;

// Canonical id: feature -> "features/<name>"; screen -> "app/screens/<name>"; overlay -> "app/overlays/<name>".
function sliceRoot(srcRelPath: string): Slice | null {
  const parts = srcRelPath.split('/');

  // Folder slice: src/features/<name>/** (behaviour identical to old featureName, no ext strip).
  if (parts[0] === 'features' && parts.length >= 2 && parts[1] !== undefined) {
    return { kind: 'feature', name: parts[1] };
  }

  // File-level page slice: pages are FLAT under alpha — exactly app/<screens|overlays>/<file>, depth 3.
  if (parts[0] === 'app' && parts.length === 3 && parts[2] !== undefined) {
    const name = parts[2].replace(SLICE_EXT_RE, '');
    if (parts[1] === 'screens') return { kind: 'screen', name };
    if (parts[1] === 'overlays') return { kind: 'overlay', name };
  }

  return null;
}

function sameSlice(a: Slice, b: Slice): boolean {
  return a.kind === b.kind && a.name === b.name;
}

function isPage(slice: Slice | null): slice is { kind: 'screen' | 'overlay'; name: string } {
  return slice !== null && slice.kind !== 'feature';
}

const SHARED_FEATURES = new Set(['editor']);

function sliceIsolationReason(from: Slice, to: Slice): string | null {
  // The inline editor is a shared editing surface consumed by both app-level pages and other
  // feature slices (workflow briefs region + review-gate trigger); any feature may import it.
  if (to.kind === 'feature' && SHARED_FEATURES.has(to.name)) {
    return null;
  }

  // PRESERVED byte-for-byte: existing cross-feature message format.
  if (from.kind === 'feature' && to.kind === 'feature') {
    return `src/features/${from.name}/** must not import from src/features/${to.name}/**`;
  }

  // Same-surface page <-> page: pages coordinate via stores, never import each other.
  if (from.kind === 'screen' && to.kind === 'screen') {
    return `src/app/screens/${from.name}.tsx must not import from src/app/screens/${to.name}.tsx (pages coordinate via stores)`;
  }
  if (from.kind === 'overlay' && to.kind === 'overlay') {
    return `src/app/overlays/${from.name}.tsx must not import from src/app/overlays/${to.name}.tsx (pages coordinate via stores)`;
  }

  // Cross-surface page <-> page: screens and overlays must not import each other directly.
  if (isPage(from) && isPage(to)) {
    return 'src/app/screens/** and src/app/overlays/** pages must not import each other directly (coordinate via stores)';
  }

  // page -> feature (composition at app level) is ALLOWED here; feature -> page is left to the
  // layer-rank rule (features rank 4 -> app rank 5). Both fall through as null.
  return null;
}

const APP_SHELL_MODULES = new Set(['root', 'router', 'provider', 'layout']);

// Returns the shell module name iff srcRelPath is a depth-2 app shell file (app/root.tsx, ...).
function appShellModule(srcRelPath: string): string | null {
  const parts = srcRelPath.split('/');
  if (parts[0] !== 'app' || parts.length !== 2 || parts[1] === undefined) return null;
  const base = parts[1].replace(SLICE_EXT_RE, '');
  return APP_SHELL_MODULES.has(base) ? base : null;
}

const ENGINE_FORBIDDEN_TOPLEVEL = ['stores', 'hooks', 'components', 'cli'] as const;

function topLevelDir(srcRelPath: string): string | null {
  const parts = srcRelPath.split('/');
  return parts.length > 1 ? (parts[0] ?? null) : null;
}

function classify(opts: {
  fromSrcRel: string;
  targetSrcRel: string;
  typeOnly: boolean;
}): string | null {
  const { fromSrcRel, targetSrcRel, typeOnly } = opts;
  const fromSlice = sliceRoot(fromSrcRel);
  const targetSlice = sliceRoot(targetSrcRel);

  // src/components/** must not import a vertical feature slice (message preserved byte-for-byte).
  if (fromSrcRel.startsWith('components/') && targetSlice?.kind === 'feature') {
    return `src/components/** must not import from src/features/** (${targetSlice.name})`;
  }

  // Slice isolation: cross-feature + page<->page (same surface & cross surface).
  // page->feature and page->shared return null here (ALLOWED — composition at app level).
  if (fromSlice !== null && targetSlice !== null && !sameSlice(fromSlice, targetSlice)) {
    const reason = sliceIsolationReason(fromSlice, targetSlice);
    if (reason !== null) return reason;
  }

  // Shell guard: pages must not reach into the app shell — they receive everything via props/stores.
  if (isPage(fromSlice)) {
    const shell = appShellModule(targetSrcRel);
    if (shell !== null) {
      return `src/app/screens/** and src/app/overlays/** pages must not import the app shell (src/app/${shell})`;
    }
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
      const reason = classify({ fromSrcRel, targetSrcRel, typeOnly });
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
