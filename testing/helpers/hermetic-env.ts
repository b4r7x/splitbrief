import { isCredentialEnvironmentName } from '../../src/utils/redact.js';

export function isTestCredentialEnvironmentName(name: string): boolean {
  return (
    isCredentialEnvironmentName(name) ||
    /^(?:ANTHROPIC|OPENAI|GEMINI|GOOGLE|OPENROUTER|COPILOT|CURSOR|AWS)_/i.test(name)
  );
}
