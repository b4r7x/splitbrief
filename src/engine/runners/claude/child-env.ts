import type { CliAuthChannelId } from '../../../core/runners/cli-tool-catalog.js';
import { sandboxCredentialValues } from '../sandbox-credential-values.js';

export function claudeCredentialValues(
  authChannel: CliAuthChannelId | undefined,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const apiKey = authChannel === 'api-key' ? env.ANTHROPIC_API_KEY : undefined;
  return [...(apiKey === undefined ? [] : [apiKey]), ...sandboxCredentialValues(env)];
}
