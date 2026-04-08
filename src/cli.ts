#!/usr/bin/env node

import { Command } from 'commander';
import { registerStartCommand } from './cli/commands/start.js';
import { registerSpecCommand } from './cli/commands/spec.js';
import { registerInitCommand } from './cli/commands/init.js';
import { registerStatusCommand } from './cli/commands/status.js';
import { registerResumeCommand } from './cli/commands/resume.js';

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
  console.error((err as Error).message);
  process.exit(1);
});
