import { Command } from 'commander';
import { join } from 'node:path';
import { resolveProjectDir } from '../setup.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { HANDOFF_TARGETS } from '../../engine/handoff/types.js';
import { listCustomRenderers } from '../../engine/handoff/load-renderer.js';
import { writeHandoffPack } from '../../engine/handoff/write.js';
import { cliError } from '../errors.js';
import { toErrorMessage } from '../../utils/format-errors.js';

const VALID_MODES = ['default', 'append', 'overwrite'] as const;
type WriteMode = (typeof VALID_MODES)[number];

export type HandoffDeps = {
  readActive: typeof readActive;
  listCustomRenderers: typeof listCustomRenderers;
  writeHandoffPack: typeof writeHandoffPack;
};

const defaultDeps: HandoffDeps = {
  readActive,
  listCustomRenderers,
  writeHandoffPack,
};

export function registerHandoffCommand(program: Command, deps: HandoffDeps = defaultDeps): void {
  program
    .command('handoff [target]')
    .description('Export a Handoff Pack for an external coding agent')
    .option('--session <id>', 'Session ID (default: active session)')
    .option('--out <dir>', 'Output directory (default: ./handoff/<target>/)')
    .option('--task <ids>', 'Comma-separated task IDs to include (default: all)')
    .option('--mode <mode>', 'default | append | overwrite (default: default)', 'default')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--list', 'List all available render targets and exit')
    .action(
      async (
        target: string = 'spec-kit',
        opts: { session?: string; out?: string; task?: string; mode?: string; project?: string; list?: boolean },
      ) => {
        try {
          const projectDir = resolveProjectDir(opts.project);

          if (opts.list) {
            console.log('Built-in targets:');
            for (const t of HANDOFF_TARGETS) {
              console.log(`  ${t}`);
            }
            const custom = deps.listCustomRenderers(projectDir);
            if (custom.length > 0) {
              console.log('Custom renderers:');
              for (const name of custom) {
                console.log(`  ${name}`);
              }
            }
            return;
          }

          const sessionId = opts.session ?? deps.readActive(projectDir);
          if (!sessionId) {
            throw cliError(
              'No session specified and no active session found. Use --session <id>.',
              1,
            );
          }

          const mode = opts.mode as WriteMode;
          if (!VALID_MODES.includes(mode)) {
            throw cliError(
              `Unknown --mode: "${opts.mode}". Valid modes: ${VALID_MODES.join(', ')}`,
              1,
            );
          }

          const outDir = opts.out ?? join(projectDir, 'handoff', target);

          const selectedTaskIds = opts.task
            ? opts.task.split(',').map((s) => s.trim())
            : undefined;

          const result = await deps.writeHandoffPack({
            projectDir,
            sessionId,
            target,
            outDir,
            ...(selectedTaskIds !== undefined && { selectedTaskIds }),
            mode,
          });

          console.log(`Handoff written to: ${result.outputDir}`);
          for (const file of result.files) {
            console.log(`  ${file}`);
          }
        } catch (err) {
          if (err instanceof Error && 'exitCode' in err) {
            throw err;
          }
          throw cliError(toErrorMessage(err), 1);
        }
      },
    );
}
