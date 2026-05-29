import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';

export function parseDiscoveredValidation(researchMarkdown: string): DiscoveredValidation | null {
  const sectionMatch = researchMarkdown.match(
    /#{2,3} Validation Tools\s*\n([\s\S]*?)(?=\n#{2,3} |\n---|$)/,
  );
  if (!sectionMatch?.[1]) return null;

  const section = sectionMatch[1];
  const language = extractField(section, 'Language');
  const typecheck = extractField(section, 'Type checker');
  const linter = extractField(section, 'Linter');
  const testRunner = extractField(section, 'Test runner');
  const testPattern = extractField(section, 'Test file pattern');

  if (!language && !typecheck && !linter && !testRunner) return null;

  const result: DiscoveredValidation = {};
  if (language) result.language = language;
  if (typecheck && typecheck !== 'none') result.typecheckCommand = typecheck;
  if (linter && linter !== 'none') result.lintCommand = linter;
  if (testRunner && testRunner !== 'none') result.testCommand = testRunner;
  if (testPattern) result.testPattern = testPattern;

  return result;
}

function extractField(section: string, label: string): string | null {
  const re = new RegExp(`\\*\\*${label}\\*\\*:\\s*(?:\`([^\`]+)\`|(.+))`, 'i');
  const match = section.match(re);
  if (!match) return null;
  return (match[1] ?? match[2] ?? '').trim() || null;
}
