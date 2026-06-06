import type { Command } from 'commander';
import { buildRunExplain } from '../../engine/orchestrator/explain/build.js';
import { formatRunExplain } from '../../engine/orchestrator/explain/format.js';
import { withCliErrors } from '../errors.js';
import { resolveProjectDir } from '../setup.js';
import { resolveSessionOrThrow } from '../sessions/resolve.js';

interface ExplainOpts {
  project?: string | undefined;
  session?: string | undefined;
  json?: boolean | undefined;
}

export function registerExplainCommand(program: Command): void {
  program
    .command('explain')
    .description('Explain routing, cost, review, and warning decisions from session artifacts')
    .option('--session <id>', 'Session ID (default: active session)')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Emit explanation as JSON', false)
    .action(async (opts: ExplainOpts) => {
      const projectDir = resolveProjectDir(opts.project);
      const sessionId = resolveSessionOrThrow(projectDir, opts.session);

      await withCliErrors(async () => {
        const explain = await buildRunExplain({ projectDir, sessionId });
        if (opts.json) {
          process.stdout.write(JSON.stringify({ type: 'run_explain', explain }, null, 2) + '\n');
          return;
        }
        console.log(formatRunExplain(explain));
      });
    });
}
