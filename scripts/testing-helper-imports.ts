import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface TestingHelperImportViolation {
  file: string;
  line: number;
  importPath: string;
  resolvedPath: string;
}

const TEST_ROOTS = ['src', 'testing', 'evals'];
const TEST_FILE_PATTERN = /\.test\.tsx?$/;

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

function lineForIndex(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function collectTestFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
    } else if (TEST_FILE_PATTERN.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function importSpecifiers(source: string): Array<{ importPath: string; index: number }> {
  const imports: Array<{ importPath: string; index: number }> = [];
  const fromPattern = /\bfrom\s+['"]([^'"]+)['"]/g;
  const dynamicPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const match of source.matchAll(fromPattern)) {
    const importPath = match[1];
    if (importPath !== undefined && match.index !== undefined) {
      imports.push({ importPath, index: match.index });
    }
  }
  for (const match of source.matchAll(dynamicPattern)) {
    const importPath = match[1];
    if (importPath !== undefined && match.index !== undefined) {
      imports.push({ importPath, index: match.index });
    }
  }

  return imports;
}

function isTopLevelTestingHelper(root: string, resolvedImportPath: string): boolean {
  const relPath = toPosix(relative(root, resolvedImportPath));
  return relPath === 'testing/helpers' || relPath.startsWith('testing/helpers/');
}

export function findTestingHelperImportViolations(
  root: string = process.cwd(),
): TestingHelperImportViolation[] {
  const rootDir = resolve(root);
  const testFiles = TEST_ROOTS.flatMap((dir) => collectTestFiles(resolve(rootDir, dir)));
  const violations: TestingHelperImportViolation[] = [];

  for (const file of testFiles) {
    const fileRelPath = toPosix(relative(rootDir, file));
    if (fileRelPath.startsWith('testing/helpers/')) continue;

    const source = readFileSync(file, 'utf-8');
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.importPath.startsWith('.')) continue;

      const resolvedImportPath = resolve(dirname(file), specifier.importPath);
      if (!isTopLevelTestingHelper(rootDir, resolvedImportPath)) continue;

      violations.push({
        file: fileRelPath,
        line: lineForIndex(source, specifier.index),
        importPath: specifier.importPath,
        resolvedPath: toPosix(relative(rootDir, resolvedImportPath)),
      });
    }
  }

  return violations;
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  for (const violation of findTestingHelperImportViolations()) {
    console.log(
      `${violation.file}:${violation.line}: relative import "${violation.importPath}" resolves to ${violation.resolvedPath}; use #testing/*`,
    );
  }
}
