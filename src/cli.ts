#!/usr/bin/env node

import { bootstrapOtel, flushOtel } from './lib/otel.js';
import { Command } from 'commander';
import ansis from 'ansis';
import { registerStartCommand } from './cli/commands/start.js';
import { registerDoctorCommand } from './cli/commands/doctor.js';
import { registerSpecCommand } from './cli/commands/spec.js';
import { registerInitCommand } from './cli/commands/init.js';
import { registerStatusCommand } from './cli/commands/status.js';
import { registerStatsCommand } from './cli/commands/stats.js';
import { registerExportCommand } from './cli/commands/export.js';
import { registerExplainCommand } from './cli/commands/explain.js';
import { registerResumeCommand } from './cli/commands/resume.js';
import { registerMigrateCommand } from './cli/commands/migrate.js';
import { registerHandoffCommand } from './cli/commands/handoff.js';
import { registerSnapshotCommand } from './cli/commands/snapshot.js';
import { registerApprovalCommand } from './cli/commands/approval.js';
import { registerMcpCommand } from './cli/commands/mcp.js';
import { registerWorktreeCommand } from './cli/commands/worktree.js';
import { registerAttachCommand } from './cli/commands/attach.js';
import { registerDetachCommand } from './cli/commands/detach.js';
import { registerPsCommand } from './cli/commands/ps.js';
import { registerContinueCommand } from './cli/commands/continue.js';
import { registerLastCommand } from './cli/commands/last.js';
import { isCliError } from './cli/errors.js';
import { HELP_EXAMPLES } from './cli/help-examples.js';
import { toErrorMessage } from './utils/format-errors.js';
import { getDiptychVersion } from './core/paths-io.js';

bootstrapOtel();

const program = new Command();

program
  .name('diptych')
  .version(getDiptychVersion())
  .description('Cost-optimized AI coding orchestrator');

program.addHelpText('after', HELP_EXAMPLES);

registerStartCommand(program);
registerDoctorCommand(program);
registerSpecCommand(program);
registerInitCommand(program);
registerStatusCommand(program);
registerStatsCommand(program);
registerExportCommand(program);
registerExplainCommand(program);
registerResumeCommand(program);
registerMigrateCommand(program);
registerHandoffCommand(program);
registerSnapshotCommand(program);
registerApprovalCommand(program);
registerMcpCommand(program);
registerWorktreeCommand(program);
registerAttachCommand(program);
registerDetachCommand(program);
registerPsCommand(program);
registerContinueCommand(program);
registerLastCommand(program);

program.parseAsync().catch(async (err) => {
  await flushOtel();
  if (isCliError(err)) {
    console.error(`${ansis.red('Error:')} ${toErrorMessage(err)}`);
    process.exit(err.exitCode);
  }
  console.error(`${ansis.red('Error:')} ${toErrorMessage(err)}`);
  process.exit(1);
});
