import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { isHooksConfigTrusted, markHooksConfigTrusted } from '../core/hooks/trust.js';
import { HOOK_EVENTS, type HookEntry, type HooksConfig } from '../core/schemas/hooks.js';
import { escapeTrustLiteral } from '../core/trust/literal.js';
import { isPathLike, resolveBareCommandOnPath } from '../core/trust/path-classification.js';
import { cliError } from './errors.js';

export interface HookTrustOptions {
  projectDir: string;
  hooks: HooksConfig | undefined;
  allowHooks: boolean;
}

export interface PromptStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

const TRUST_QUESTION = 'Trust these hooks for this project? [y/N] ';
const DISCLOSURE_HEADING = 'SPLITBRIEF config declares hooks this machine has not trusted:';

export async function promptHookTrust(
  question: string,
  streams: PromptStreams = { input: process.stdin, output: process.stderr },
): Promise<string> {
  const rl = createInterface({ input: streams.input, output: streams.output });
  const eof = Symbol('eof');
  const closed = new Promise<typeof eof>((resolve) => rl.once('close', () => resolve(eof)));
  const raw = await Promise.race([rl.question(question), closed]);
  rl.close();
  return raw === eof ? '' : raw;
}

export async function ensureHooksTrusted(
  opts: HookTrustOptions,
  promptForTrust: (question: string) => Promise<string> = promptHookTrust,
): Promise<void> {
  if (!opts.hooks) return;
  if (isHooksConfigTrusted(opts.projectDir, opts.hooks)) return;

  const disclosure = formatHookTrustDisclosure(opts.projectDir, opts.hooks);

  if (opts.allowHooks) {
    process.stderr.write(`\n${disclosure}\n`);
    markHooksConfigTrusted(opts.projectDir, opts.hooks);
    return;
  }
  if (!process.stdin.isTTY) {
    throw cliError(
      'Hook config is not trusted and no TTY available. Re-run with --allow-hooks to trust it (CI usage).',
      1,
    );
  }

  // The disclosure is the question, not a preamble printed beside it: whatever
  // surface answers this prompt cannot answer it without having shown what it
  // authorizes.
  const raw = await promptForTrust(`\n${disclosure}\n\n${TRUST_QUESTION}`);

  const answer = raw.trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    throw cliError(
      'Refusing to run with untrusted hooks. Edit .splitbrief/config.yaml or re-run and answer y.',
      1,
    );
  }
  markHooksConfigTrusted(opts.projectDir, opts.hooks);
}

/**
 * Names the command, not the label. A `name:` the repository chose for itself
 * is never shown here, because the owner is authorizing an executable and its
 * argv — the two things that decide what actually runs.
 */
export function formatHookTrustDisclosure(projectDir: string, hooks: HooksConfig): string {
  const declared: string[] = [];
  for (const event of HOOK_EVENTS) {
    for (const entry of hooks[event] ?? []) {
      declared.push('', `  ${event}:`, ...hookEntryLines(projectDir, entry));
    }
  }
  if (declared.length === 0) return `${DISCLOSURE_HEADING}\n\n  (only built-ins enabled)`;
  return [
    DISCLOSURE_HEADING,
    ...declared,
    '',
    '  Execution: runs on this machine as you, in the project directory, on every matching workflow event',
    '  Environment access: Inherits the full SPLITBRIEF process environment, including credentials',
    '  Filesystem: Not an OS sandbox; the process can access files available to the current user',
    '  Network: Network access is not restricted',
  ].join('\n');
}

function hookEntryLines(projectDir: string, entry: HookEntry): string[] {
  return [
    `    Executable: ${escapeTrustLiteral(entry.command)}`,
    `    Resolved: ${escapeTrustLiteral(resolveHookExecutable(projectDir, entry.command))}`,
    `    Arguments: ${
      entry.args.length === 0 ? '(none)' : entry.args.map(escapeTrustLiteral).join(' ')
    }`,
    `    On failure: ${entry.on_failure}`,
  ];
}

/**
 * Hooks are spawned with the project directory as cwd, so a bare name is
 * whatever `PATH` resolves to there — including a binary the repository itself
 * dropped into a `PATH` entry.
 */
function resolveHookExecutable(projectDir: string, command: string): string {
  if (isPathLike(command)) return resolve(projectDir, command);
  return resolveBareCommandOnPath(command, projectDir) ?? '(not found on PATH)';
}
