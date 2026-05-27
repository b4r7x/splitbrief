import type { Command } from 'commander';
import { join } from 'node:path';
import { resolveProjectDir } from '../setup.js';
import { HANDOFF_TARGETS, validateHandoffTargetName } from '../../core/handoff/targets.js';
import { listCustomRenderers } from '../../engine/handoff/load-renderer.js';
import { writeHandoffPack } from '../../engine/handoff/write.js';
import { cliError, rethrowAsCli } from '../errors.js';
import { resolveSessionOrThrow } from '../session-resolve.js';

const VALID_MODES = ['default', 'append', 'overwrite'] as const;
type WriteMode = (typeof VALID_MODES)[number];

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
    .option('--out <dir>', 'Output directory (default: .diptych/handoffs/<target>/)')
    .option('--task <ids>', 'Comma-separated task IDs to include (default: all)')
    .option('--mode <mode>', 'default | append | overwrite (default: default)', 'default')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--list', 'List all available render targets and exit')
    .option('--allow-custom-renderer', 'Trust and load repo-local custom renderers', false)
    .action(
      async (
        target: string = 'spec-kit',
        opts: { session?: string; out?: string; task?: string; mode?: string; project?: string; list?: boolean; allowCustomRenderer?: boolean },
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

          const sessionId = resolveSessionOrThrow(projectDir, opts.session);

          const rawMode = opts.mode;
          if (!VALID_MODES.includes(rawMode as WriteMode)) {
            throw cliError(
              `Unknown --mode: "${rawMode}". Valid modes: ${VALID_MODES.join(', ')}`,
              1,
            );
          }
          const mode = rawMode as WriteMode;

          const targetValidation = validateHandoffTargetName(target);
          if (!targetValidation.ok) {
            throw cliError(`Invalid target "${target}": ${targetValidation.reason}`, 1);
          }

          const outDir = opts.out ?? join(projectDir, '.diptych', 'handoffs', target);

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
            ...(opts.allowCustomRenderer !== undefined && { allowCustomRenderer: opts.allowCustomRenderer }),
          });

          console.log(`Handoff written to: ${result.outputDir}`);
          for (const file of result.files) {
            console.log(`  ${file}`);
          }
        } catch (err) {
          rethrowAsCli(err);
        }
      },
    );
}
