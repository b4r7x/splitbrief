#!/usr/bin/env node

import { Command } from 'commander';
import ansis from 'ansis';
import { registerStartCommand } from './cli/commands/start.js';
import { registerSpecCommand } from './cli/commands/spec.js';
import { registerInitCommand } from './cli/commands/init.js';
import { registerStatusCommand } from './cli/commands/status.js';
import { registerResumeCommand } from './cli/commands/resume.js';
import { isCliError } from './cli/errors.js';
import { toErrorMessage } from './utils/format.js';

const program = new Command();

program
  .name('tiny-spec')
  .version('0.1.0')
  .description('Cost-optimized AI coding orchestrator');

registerStartCommand(program);
registerSpecCommand(program);
registerInitCommand(program);
registerStatusCommand(program);
registerResumeCommand(program);

program.parseAsync().catch((err) => {
  if (isCliError(err)) {
    console.error(`${ansis.red('Error:')} ${err.message}`);
    process.exit(err.exitCode);
  }
  console.error(`${ansis.red('Error:')} ${toErrorMessage(err)}`);
  process.exit(1);
});
