import type { CliToolId } from '../../../../core/runners/cli-tool/types.js';
import type { CliProbeCommand, CliAuthProbe, CliVersionProbe } from './contract.js';

const FORBIDDEN_PROBE_ARGUMENTS = new Set([
  'download',
  'exec',
  'install',
  'login',
  'pull',
  'refresh',
  'run',
  'sync',
  'update',
  'upgrade',
]);

export function hasForbiddenProbeArgument(command: CliProbeCommand): boolean {
  return command.command.slice(1).some((argument) => {
    const normalized = argument.toLowerCase();
    return (
      FORBIDDEN_PROBE_ARGUMENTS.has(normalized) ||
      FORBIDDEN_PROBE_ARGUMENTS.has(normalized.replace(/^--/, ''))
    );
  });
}

/**
 * `codex login status` is a documented read-only status command. Keep this
 * exception exact: an alias, flag, extra argument, or another tool continues
 * through the mutating-command denylist.
 */
function isExactCodexLoginStatusProbe({
  tool,
  command,
}: Readonly<{
  tool: CliToolId;
  command: CliProbeCommand;
}>): boolean {
  return (
    tool === 'codex' &&
    command.command.length === 3 &&
    command.command[0] === 'codex' &&
    command.command[1] === 'login' &&
    command.command[2] === 'status'
  );
}

function probeCommandsMatch({
  left,
  right,
}: Readonly<{
  left: CliProbeCommand;
  right: CliProbeCommand;
}>): boolean {
  return (
    left.command.length === right.command.length &&
    left.command.every((argument, index) => argument === right.command[index])
  );
}

export function declaredAuthProbeIsSafe({
  tool,
  auth,
  version,
}: Readonly<{
  tool: CliToolId;
  auth: CliAuthProbe;
  version: CliVersionProbe;
}>): boolean {
  if (auth.kind === 'not-run') return false;
  if (hasForbiddenProbeArgument(auth) && !isExactCodexLoginStatusProbe({ tool, command: auth })) {
    return false;
  }
  if (probeCommandsMatch({ left: auth, right: version })) return false;
  return !auth.command
    .slice(1)
    .some((argument) => argument === '--version' || argument === 'version');
}

/**
 * Registry declarations are execution policy, not a convenient view of the
 * adapter. Copy each tuple before freezing so an adapter module (or an
 * imported catalog descriptor) cannot retain a mutable alias to argv.
 */
export function ownedProbeCommand(
  command: readonly [string, ...string[]],
): readonly [string, ...string[]] {
  return Object.freeze([command[0], ...command.slice(1)] as [string, ...string[]]);
}
