#!/usr/bin/env node

import { bootstrapOtel } from './cli/otel-bootstrap.js';
import { Command } from 'commander';
import ansis from 'ansis';
import { registerStartCommand } from './cli/commands/start.js';
import { registerSpecCommand } from './cli/commands/spec.js';
import { registerInitCommand } from './cli/commands/init.js';
import { registerStatusCommand } from './cli/commands/status.js';
import { registerResumeCommand } from './cli/commands/resume.js';
import { registerMigrateCommand } from './cli/commands/migrate.js';
import { registerHandoffCommand } from './cli/commands/handoff.js';
import { registerSnapshotCommand } from './cli/commands/snapshot.js';
import { registerApprovalCommand } from './cli/commands/approval.js';
import { registerMcpCommand } from './cli/commands/mcp.js';
import { registerWorktreeCommand } from './cli/commands/worktree.js';
import { registerAttachCommand } from './cli/commands/attach.js';
import { registerPsCommand } from './cli/commands/ps.js';
import { isCliError } from './cli/errors.js';
import { toErrorMessage } from './utils/format-errors.js';

bootstrapOtel();

const program = new Command();

program
  .name('diptych')
  .version('0.1.0')
  .description('Cost-optimized AI coding orchestrator');

registerStartCommand(program);
registerSpecCommand(program);
registerInitCommand(program);
registerStatusCommand(program);
registerResumeCommand(program);
registerMigrateCommand(program);
registerHandoffCommand(program);
registerSnapshotCommand(program);
registerApprovalCommand(program);
registerMcpCommand(program);
registerWorktreeCommand(program);
registerAttachCommand(program);
registerPsCommand(program);

program.parseAsync().catch((err) => {
  if (isCliError(err)) {
    console.error(`${ansis.red('Error:')} ${err.message}`);
    process.exit(err.exitCode);
  }
  console.error(`${ansis.red('Error:')} ${toErrorMessage(err)}`);
  process.exit(1);
});
