import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { error } from '../../../utils/error.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import type { CliInvocation, CliProcessAdapter } from './contract.js';

const PROMPT_FILE_NAME = 'prompt.txt';

export type PreparedPrompt = Readonly<{
  args: string[];
  stdin: string | undefined;
  cleanup: () => Promise<void>;
}>;

export async function preparePrompt(
  adapter: CliProcessAdapter,
  invocation: CliInvocation,
  invocationArgs: readonly string[],
  prompt: string,
): Promise<PreparedPrompt> {
  const transport = adapter.promptTransport;
  if (transport.kind !== invocation.promptTransport.kind) {
    throw error(
      'prompt-transport-error',
      'Invocation prompt transport does not match the adapter contract',
    );
  }
  if (transport.kind === 'stdin') {
    rejectPlaceholder(invocationArgs);
    return { args: [...invocationArgs], stdin: prompt, cleanup: async () => {} };
  }
  if (transport.kind === 'argv') {
    const bytes = Buffer.byteLength(prompt, 'utf8');
    if (bytes > transport.maxBytes) {
      throw transportError(
        `CLI prompt is ${bytes} bytes and exceeds the ${transport.maxBytes}-byte argv limit`,
      );
    }
    if (transport.placement === 'positional' && prompt.startsWith('-')) {
      // The tool's own parser would read the prompt as an option and silently
      // change its model, sandbox, or permission semantics.
      throw transportError('CLI prompt taken as a positional argument cannot start with "-"');
    }
    return {
      args: replacePromptArgument(invocationArgs, prompt),
      stdin: undefined,
      cleanup: async () => {},
    };
  }

  const directory = await mkdtemp(join(tmpdir(), 'splitbrief-prompt-'));
  const path = join(directory, PROMPT_FILE_NAME);
  try {
    await writeFile(path, prompt, { encoding: 'utf8', flag: 'wx', mode: transport.mode });
    await chmod(path, transport.mode);
    return {
      args: replacePromptArgument(invocationArgs, path),
      stdin: undefined,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
}

function replacePromptArgument(args: readonly string[], replacement: string): string[] {
  const matches = args.filter((arg) => arg === CLI_PROMPT_SENTINEL).length;
  if (matches !== 1) {
    throw transportError('Prompt transport requires exactly one standalone <PROMPT> argument');
  }
  return args.map((arg) => (arg === CLI_PROMPT_SENTINEL ? replacement : arg));
}

function rejectPlaceholder(args: readonly string[]): void {
  if (args.some((arg) => arg.includes(CLI_PROMPT_SENTINEL))) {
    throw transportError('stdin prompt transport cannot include a prompt placeholder in argv');
  }
}

function transportError(message: string): Error {
  return error('prompt-transport-error', message);
}
