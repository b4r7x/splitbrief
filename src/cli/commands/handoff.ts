import type { Command } from 'commander';
import { resolveProjectDir } from '../setup.js';
import {
  HANDOFF_TARGETS,
  normalizeHandoffTarget,
  validateHandoffTargetName,
} from '../../core/handoff/targets.js';
import { getSplitbriefPath } from '../../core/paths.js';
import { listCustomRenderers } from '../../engine/handoff/load-renderer.js';
import { HANDOFF_WRITE_MODES, writeHandoffPack } from '../../engine/handoff/write.js';
import { cliError, withCliErrors } from '../errors.js';
import { resolveSessionOrThrow } from '../sessions/resolve.js';
import { includes } from '../../utils/type-guards.js';

export type HandoffDeps = {
  listCustomRenderers: typeof listCustomRenderers;
  writeHandoffPack: typeof writeHandoffPack;
};

const defaultDeps: HandoffDeps = {
  listCustomRenderers,
  writeHandoffPack,
};

export function registerHandoffCommand(program: Command, deps: HandoffDeps = defaultDeps): void {
  program
    .command('handoff [target]')
    .description('Export a Handoff Pack for an external coding agent')
    .option('--session <id>', 'Session ID (default: active session)')
    .option('--out <dir>', 'Output directory (default: .splitbrief/handoffs/<target>/)')
    .option('--task <ids>', 'Comma-separated task IDs to include (default: all)')
    .option('--mode <mode>', 'default | append | overwrite (default: default)', 'default')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--list', 'List all available render targets and exit')
    .option('--allow-custom-renderer', 'Trust and load repo-local custom renderers', false)
    .action(
      async (
        target: string = 'spec-kit',
        opts: {
          session?: string;
          out?: string;
          task?: string;
          mode?: string;
          project?: string;
          list?: boolean;
          allowCustomRenderer?: boolean;
        },
      ) =>
        withCliErrors(async () => {
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

          const sessionId = await resolveSessionOrThrow(projectDir, opts.session);

          const resolvedTarget = normalizeHandoffTarget(target);

          const rawMode = opts.mode;
          if (!includes(HANDOFF_WRITE_MODES, rawMode)) {
            throw cliError(
              `Unknown --mode: "${rawMode}". Valid modes: ${HANDOFF_WRITE_MODES.join(', ')}`,
              1,
            );
          }
          const mode = rawMode;

          const targetValidation = validateHandoffTargetName(resolvedTarget);
          if (!targetValidation.ok) {
            throw cliError(`Invalid target "${resolvedTarget}": ${targetValidation.reason}`, 1);
          }

          const outDir = opts.out ?? getSplitbriefPath(projectDir, 'handoffs', resolvedTarget);

          const selectedTaskIds = opts.task ? opts.task.split(',').map((s) => s.trim()) : undefined;

          const result = await deps.writeHandoffPack({
            projectDir,
            sessionId,
            target: resolvedTarget,
            outDir,
            ...(selectedTaskIds !== undefined && { selectedTaskIds }),
            mode,
            ...(opts.allowCustomRenderer !== undefined && {
              allowCustomRenderer: opts.allowCustomRenderer,
            }),
          });

          console.log(`Handoff written to: ${result.outputDir}`);
          for (const file of result.files) {
            console.log(`  ${file}`);
          }
        }),
    );
}
