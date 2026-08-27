import type { CustomCommandContract } from '../../core/config/custom-commands.js';
import { CliExecutableReceiptSchema } from '../../core/discovery/detection.js';
import { escapeTrustLiteral } from '../../core/trust/literal.js';
import { assertNever } from '../../utils/type-guards.js';
import {
  parseConfiguredCustomRunner,
  parseCustomRunnerSecurityPosture,
  postureDescribesRunner,
  type CustomRunnerSecurityPosture,
} from './custom-trust.js';

export type CustomRunnerDisclosure = Readonly<{
  executable: string;
  argv: readonly string[];
  contract: CustomCommandContract;
  cwd: 'Disposable staged project' | 'Project directory';
  stage: 'Filtered disposable stage' | 'None';
  environment: readonly string[];
  environmentAccess:
    | 'Declared environment references only'
    | 'Inherits the full SPLITBRIEF process environment, including credentials';
  filesystem: 'Not an OS sandbox; the process can access files available to the current user';
  network: 'Network access is not restricted';
  result:
    | 'Parsed output only; stage-local writes are discarded'
    | 'Reviewed declared artifact for normal planner calls; reviewed workspace diff for full escalation only'
    | 'Reviewed diff only'
    | 'Parsed stdout only; anything it writes in the project is neither staged nor reviewed'
    | 'Reviewed workspace diff; it writes directly into the project directory';
}>;

function disclosureResult(
  result: CustomRunnerSecurityPosture['result'],
): CustomRunnerDisclosure['result'] {
  switch (result) {
    case 'parsed-output-only':
      return 'Parsed output only; stage-local writes are discarded';
    case 'reviewed-declared-artifact-or-workspace-diff-only':
      return 'Reviewed declared artifact for normal planner calls; reviewed workspace diff for full escalation only';
    case 'reviewed-diff-only':
      return 'Reviewed diff only';
    case 'inline-parsed-output-only':
      return 'Parsed stdout only; anything it writes in the project is neither staged nor reviewed';
    case 'inline-workspace-writes':
      return 'Reviewed workspace diff; it writes directly into the project directory';
    default:
      return assertNever(result);
  }
}

export function buildCustomRunnerDisclosure(
  input: Readonly<{
    runner: unknown;
    posture: unknown;
    executable: unknown;
  }>,
): CustomRunnerDisclosure | null {
  const runner = parseConfiguredCustomRunner(input.runner);
  const posture = parseCustomRunnerSecurityPosture(input.posture);
  const executable = CliExecutableReceiptSchema.safeParse(input.executable);
  if (runner === null || posture === null || !executable.success) return null;
  if (!postureDescribesRunner(posture, runner)) return null;
  return {
    executable: escapeTrustLiteral(executable.data.path),
    argv: runner.command.argv.map(escapeTrustLiteral),
    contract: runner.command.contract,
    cwd: posture.cwd === 'disposable-stage' ? 'Disposable staged project' : 'Project directory',
    stage: posture.stage === 'filtered-disposable-stage' ? 'Filtered disposable stage' : 'None',
    environment: runner.command.env.map(escapeTrustLiteral),
    environmentAccess:
      posture.environmentAccess === 'declared-references-only'
        ? 'Declared environment references only'
        : 'Inherits the full SPLITBRIEF process environment, including credentials',
    filesystem: 'Not an OS sandbox; the process can access files available to the current user',
    network: 'Network access is not restricted',
    result: disclosureResult(posture.result),
  };
}

export function formatCustomRunnerDisclosure(disclosure: CustomRunnerDisclosure): string {
  return [
    `Executable: ${disclosure.executable}`,
    `Arguments: ${disclosure.argv.length === 0 ? '(none)' : disclosure.argv.join(' ')}`,
    `Contract: ${disclosure.contract}`,
    `Working directory: ${disclosure.cwd}`,
    `Staging: ${disclosure.stage}`,
    `Environment names: ${
      disclosure.environment.length === 0 ? '(none)' : disclosure.environment.join(', ')
    }`,
    `Environment access: ${disclosure.environmentAccess}`,
    `Filesystem: ${disclosure.filesystem}`,
    `Network: ${disclosure.network}`,
    `Result: ${disclosure.result}`,
  ].join('\n');
}
