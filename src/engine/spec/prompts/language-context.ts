import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LanguageContext {
  language: string;
  importConvention: string;
  typeAnnotationStyle: string;
  fileExtension: string;
  moduleSystem: string;
}

export function normalizeLanguage(language: string | undefined): string | undefined {
  const normalized = language?.trim().toLowerCase().replace(/^`|`$/g, '');
  if (!normalized) return undefined;
  if (normalized === 'ts') return 'typescript';
  if (normalized === 'js') return 'javascript';
  if (normalized.includes('typescript')) return 'typescript';
  if (normalized.includes('javascript')) return 'javascript';
  if (normalized.includes('python')) return 'python';
  if (normalized.includes('rust')) return 'rust';
  if (normalized === 'go' || normalized === 'golang' || normalized.includes('golang') || /\bgo\b/.test(normalized)) return 'go';
  return normalized;
}

export function buildLanguageContext(language: string | undefined): LanguageContext {
  switch (normalizeLanguage(language)) {
    case 'typescript':
      return {
        language: 'TypeScript',
        importConvention: 'ESM imports with .js extensions',
        typeAnnotationStyle: 'TypeScript type annotations',
        fileExtension: '.ts',
        moduleSystem: 'ESM',
      };
    case 'javascript':
      return {
        language: 'JavaScript',
        importConvention: 'ESM imports with .js extensions',
        typeAnnotationStyle: 'JSDoc types or project-appropriate JavaScript annotations',
        fileExtension: '.js',
        moduleSystem: 'ESM',
      };
    case 'python':
      return {
        language: 'Python',
        importConvention: 'Python import statements (from/import)',
        typeAnnotationStyle: 'Python type hints (PEP 484)',
        fileExtension: '.py',
        moduleSystem: 'Python modules',
      };
    case 'go':
      return {
        language: 'Go',
        importConvention: 'Go import paths',
        typeAnnotationStyle: 'Go type declarations',
        fileExtension: '.go',
        moduleSystem: 'Go packages',
      };
    case 'rust':
      return {
        language: 'Rust',
        importConvention: 'Rust use/mod statements',
        typeAnnotationStyle: 'Rust type annotations',
        fileExtension: '.rs',
        moduleSystem: 'Rust crates/modules',
      };
    default:
      return {
        language: 'the project language',
        importConvention: 'standard import statements for the project language',
        typeAnnotationStyle: 'type annotations appropriate for the project language',
        fileExtension: '',
        moduleSystem: 'the project module system',
      };
  }
}

export function isJavaScriptLikeLanguage(ctx: LanguageContext): boolean {
  return ctx.language === 'TypeScript' || ctx.language === 'JavaScript';
}

export function codeFenceLanguage(ctx: LanguageContext): string {
  switch (ctx.language) {
    case 'TypeScript':
      return 'typescript';
    case 'JavaScript':
      return 'javascript';
    case 'Python':
      return 'python';
    case 'Go':
      return 'go';
    case 'Rust':
      return 'rust';
    default:
      return '';
  }
}

export function detectPromptLanguage(projectDir: string): string | undefined {
  if (existsSync(join(projectDir, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(projectDir, 'go.mod'))) return 'go';
  if (existsSync(join(projectDir, 'pyproject.toml'))) return 'python';

  const pkgPath = join(projectDir, 'package.json');
  if (!existsSync(pkgPath)) return undefined;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return deps.typescript ? 'typescript' : 'javascript';
  } catch {
    return undefined;
  }
}

export function extractLanguageFromResearch(researchMarkdown: string): string | undefined {
  const match = researchMarkdown.match(/\*\*Language\*\*:\s*(?:`([^`]+)`|([^\n]+))/i);
  return normalizeLanguage(match?.[1] ?? match?.[2]);
}

export function buildLanguageContextSections(ctx: LanguageContext): Array<{ heading: string; body: string }> {
  if (isJavaScriptLikeLanguage(ctx)) return [];
  return [{
    heading: 'Language Context',
    body: `Target language: ${ctx.language}\nModule system: ${ctx.moduleSystem}\nImports: ${ctx.importConvention}\nTypes: ${ctx.typeAnnotationStyle}\nFile extension: ${ctx.fileExtension || 'project-specific'}`,
  }];
}

export function buildProjectLanguageContext(projectDir: string, language: string | undefined): LanguageContext {
  return buildLanguageContext(language ?? detectPromptLanguage(projectDir));
}
