import { error } from '../../../utils/error.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import type { CliInvocation, CliProcessAdapter } from './contract.js';

export type PreparedPrompt = Readonly<{
  args: string[];
  stdin: string;
}>;

export async function preparePrompt(
  adapter: CliProcessAdapter,
  invocation: CliInvocation,
  invocationArgs: readonly string[],
  raw: string,
): Promise<PreparedPrompt> {
  const prompt =
    adapter.encodePrompt === undefined
      ? raw
      : await adapter.encodePrompt({ invocation, prompt: raw });
  rejectPlaceholder(invocationArgs);
  return { args: [...invocationArgs], stdin: prompt };
}

function rejectPlaceholder(args: readonly string[]): void {
  if (args.some((arg) => arg.includes(CLI_PROMPT_SENTINEL))) {
    throw error(
      'prompt-transport-error',
      'stdin prompt transport cannot include a prompt placeholder in argv',
    );
  }
}
