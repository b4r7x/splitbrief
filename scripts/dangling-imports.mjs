import { readFileSync, existsSync, statSync, globSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import ts from 'typescript';

const files = globSync('{src,testing,scripts}/**/*.{ts,tsx,mts}').sort();

// Real import/export statements only: must start the line (optionally indented by nothing).
const IMPORT =
  /^(?:import|export)\b[^;]*?from\s*['"](\.[^'"]+)['"]|(?:await\s+)?import\(\s*['"](\.[^'"]+)['"]\s*\)/gm;
const MOCK = /\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\b/;
const MOCK_CALLS = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock']);
const dangling = [];
const danglingMocks = [];
const staleKeys = [];

function resolveSpec(file, spec) {
  const base = resolve(dirname(file), spec);
  const cands = spec.endsWith('.js')
    ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base]
    : [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
  return cands.find((c) => existsSync(c) && statSync(c).isFile());
}

function bindingNames(name, names) {
  if (ts.isIdentifier(name)) names.add(name.text);
  else
    for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, names);
}

// The export names of a module, or null when an `export *` hides them.
function exportNames(path) {
  const names = new Set();
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf-8'), ts.ScriptTarget.Latest);
  for (const node of sf.statements) {
    if (ts.isExportDeclaration(node)) {
      if (node.exportClause === undefined) return null;
      if (ts.isNamespaceExport(node.exportClause)) names.add(node.exportClause.name.text);
      else for (const el of node.exportClause.elements) names.add(el.name.text);
    } else if (ts.isExportAssignment(node)) {
      names.add('default');
    } else if (ts.canHaveModifiers(node)) {
      const modifiers = ts.getModifiers(node) ?? [];
      if (!modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) names.add('default');
      else if (ts.isVariableStatement(node))
        for (const d of node.declarationList.declarations) bindingNames(d.name, names);
      else if (node.name !== undefined) names.add(node.name.text);
    }
  }
  return names;
}

function returnedObjects(factory) {
  if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) return [];
  const returned = [];
  if (ts.isBlock(factory.body)) {
    const visit = (node) => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression !== undefined)
        returned.push(node.expression);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(factory.body, visit);
  } else {
    returned.push(factory.body);
  }
  return returned
    .map((e) => (ts.isParenthesizedExpression(e) ? e.expression : e))
    .filter((e) => ts.isObjectLiteralExpression(e));
}

function checkMock(file, sf, call) {
  const [pathArg, factory] = call.arguments;
  if (pathArg === undefined || !ts.isStringLiteralLike(pathArg) || !pathArg.text.startsWith('.'))
    return;
  const spec = pathArg.text;
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const target = resolveSpec(file, spec);
  if (target === undefined) {
    danglingMocks.push({ file, line: lineOf(pathArg), spec });
    return;
  }
  if (!['mock', 'doMock'].includes(call.expression.name.text) || factory === undefined) return;
  const objects = returnedObjects(factory);
  const names = objects.length > 0 ? exportNames(target) : null;
  if (names === null) return;
  for (const object of objects)
    for (const p of object.properties) {
      if (p.name === undefined || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)))
        continue;
      if (!names.has(p.name.text))
        staleKeys.push({ file, line: lineOf(p.name), spec, key: p.name.text });
    }
}

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
    if (resolveSpec(file, spec) !== undefined) continue;
    dangling.push({ file, line: src.slice(0, m.index).split('\n').length, spec });
  }
  if (!MOCK.test(src)) continue;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest);
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'vi' &&
      MOCK_CALLS.has(node.expression.name.text)
    )
      checkMock(file, sf, node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function report(list, noun) {
  if (list.length === 0) return;
  const fileCount = new Set(list.map((d) => d.file)).size;
  console.log(`${list.length} ${noun} in ${fileCount} file(s) of ${files.length} scanned:\n`);
  for (const d of list) {
    const key = d.key === undefined ? '' : ` has no export '${d.key}'`;
    console.log(`  ${d.file}:${d.line} -> ${d.spec}${key}`);
  }
  process.exitCode = 1;
}

if (dangling.length + danglingMocks.length + staleKeys.length === 0) {
  console.log(`clean — ${files.length} files scanned`);
} else {
  report(dangling, 'dangling import(s)');
  report(danglingMocks, 'dangling mock path(s)');
  report(staleKeys, 'stale mock factory key(s)');
}
