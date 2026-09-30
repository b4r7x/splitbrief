import {
  researchField,
  validationToolsSection,
} from '../../../core/pipeline-spec/research-fields.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';

export function parseDiscoveredValidation(researchMarkdown: string): DiscoveredValidation | null {
  const section = validationToolsSection(researchMarkdown);
  if (section === undefined) return null;

  const language = researchField(section, 'Language');
  const typecheck = researchField(section, 'Type checker');
  const linter = researchField(section, 'Linter');
  const testRunner = researchField(section, 'Test runner');
  const testPattern = researchField(section, 'Test file pattern');

  if (!language && !typecheck && !linter && !testRunner) return null;

  const result: DiscoveredValidation = {};
  if (language) result.language = language;
  if (typecheck && typecheck !== 'none') result.typecheckCommand = typecheck;
  if (linter && linter !== 'none') result.lintCommand = linter;
  if (testRunner && testRunner !== 'none') result.testCommand = testRunner;
  if (testPattern) result.testPattern = testPattern;

  return result;
}
