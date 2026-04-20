import { createInterface } from 'node:readline/promises';
import type { HooksConfig } from '../core/schemas/hooks.js';
import { isHooksConfigTrusted, markHooksConfigTrusted } from '../core/hooks/trust.js';
import { cliError } from './errors.js';

export interface HookTrustOptions {
  projectDir: string;
  hooks: HooksConfig | undefined;
  allowHooks: boolean;
}

export async function ensureHooksTrusted(opts: HookTrustOptions): Promise<void> {
  if (!opts.hooks) return;
  if (isHooksConfigTrusted(opts.projectDir, opts.hooks)) return;
  if (opts.allowHooks) {
    markHooksConfigTrusted(opts.projectDir, opts.hooks);
    return;
  }
  if (!process.stdin.isTTY) {
    throw cliError(
      'Hook config is not trusted and no TTY available. Re-run with --allow-hooks to trust it (CI usage).',
      1,
    );
  }

  const summary = formatHookSummary(opts.hooks);
  process.stderr.write(`\n  diptych config defines hooks (untrusted):\n${summary}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question('Trust these hooks for this project? [y/N] ')).trim().toLowerCase();
  rl.close();

  if (answer !== 'y' && answer !== 'yes') {
    throw cliError(
      'Refusing to run with untrusted hooks. Edit .diptych/config.yml or re-run and answer y.',
      1,
    );
  }
  markHooksConfigTrusted(opts.projectDir, opts.hooks);
}

function formatHookSummary(hooks: HooksConfig): string {
  const lines: string[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    if (event === 'builtin' || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      const label = entry.name ?? (entry.kind === 'module' ? entry.path : entry.command);
      const args = entry.kind === 'command' && entry.args.length > 0 ? ` ${entry.args.join(' ')}` : '';
      lines.push(`  ${event}: ${label}${args}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : '  (only built-ins enabled)';
}
