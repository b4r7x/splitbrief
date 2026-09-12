#!/usr/bin/env node

import { Command } from 'commander';
import ansis from 'ansis';
import { registerStartCommand } from './cli/commands/start/register.js';
import { registerDoctorCommand } from './cli/commands/doctor.js';
import { registerSpecCommand } from './cli/commands/spec.js';
import { registerInitCommand } from './cli/commands/init.js';
import { registerStatusCommand } from './cli/commands/status.js';
import { registerResumeCommand } from './cli/commands/resume.js';
import { registerReviewCommand } from './cli/commands/review.js';
import { registerApprovalCommand } from './cli/commands/approval.js';
import { registerContinueCommand } from './cli/commands/continue/register.js';
import { isCliError } from './cli/errors.js';
import { assertSupportedNodeVersion } from './cli/node-guard.js';
import { assertNotMistypedCommand } from './cli/unknown-command.js';
import { valueTakingFlags } from './cli/options.js';
import { HELP_EXAMPLES } from './cli/help-examples.js';
import { toErrorMessage } from './utils/format-errors.js';
import { createLogger } from './lib/logger.js';
import { getSplitbriefVersion } from './core/paths-io.js';
import { SPLITBRIEF_IDENTITY } from './core/identity.js';

const program = new Command();

program
  .name(SPLITBRIEF_IDENTITY.executable)
  .version(getSplitbriefVersion())
  .description(
    `${SPLITBRIEF_IDENTITY.displayName} — an orchestrator of two coding tools: one plans and reviews, the other executes, and it holds the contract, validation, retry, escalation and evidence`,
  );

program.addHelpText('after', HELP_EXAMPLES);

registerStartCommand(program);
registerDoctorCommand(program);
registerSpecCommand(program);
registerInitCommand(program);
registerStatusCommand(program);
registerResumeCommand(program);
registerReviewCommand(program);
registerApprovalCommand(program);
registerContinueCommand(program);

async function main(): Promise<void> {
  assertSupportedNodeVersion();
  assertNotMistypedCommand(
    process.argv.slice(2),
    program.commands.flatMap((command) => [command.name(), ...command.aliases()]),
    valueTakingFlags(program),
  );
  await program.parseAsync();
}

main().catch((err) => {
  const message = toErrorMessage(err, { preserveLineBreaks: true });
  // No-op for fatals before bootstrapStoresSync configures the logger: projectDir is
  // unknown then, and configuring from cwd would create .splitbrief outside the project.
  createLogger('cli').error('fatal', {
    message,
    stack: err instanceof Error ? err.stack : undefined,
  });
  console.error(`${ansis.red('Error:')} ${message}`);
  process.exit(isCliError(err) ? err.exitCode : 1);
});
