import { Command } from 'commander';
import { addWorkflowOptions } from '../../src/cli/options/workflow.js';
import type { WorkflowOpts } from '../../src/core/types/config-options.js';

export function parseWorkflowOptions(args: string[]): WorkflowOpts {
  const command = addWorkflowOptions(new Command('continue'));
  command.parse(['node', 'splitbrief', ...args]);
  return command.opts<WorkflowOpts>();
}
