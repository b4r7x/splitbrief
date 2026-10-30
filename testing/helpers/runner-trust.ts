import { resolveImplementerProfiles } from '../../src/core/config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../src/core/config/accessors/reviewer-runner.js';
import {
  inlineRunnerCommand,
  isCustomCommandRunner,
} from '../../src/core/config/custom-commands.js';
import { findConfiguredCustomCommand } from '../../src/core/config/custom-command-catalog.js';
import type { Config } from '../../src/core/schemas/config.js';
import {
  inlineRunnerSecurityPosture,
  markCustomRunnerTrusted,
} from '../../src/engine/runners/custom-trust.js';
import { resolveCustomExecutable } from '../../src/engine/runners/resolve-cli-executable.js';

/**
 * Models a machine whose owner already confirmed the `shell`/`agent` runner
 * commands a fixture config declares. Fixtures that exercise something else —
 * routing, navigation, streaming — would otherwise stop at the runner trust
 * prompt. Pass a `stateDir`, or stub `HOME`, so no receipt reaches the
 * developer's own trust store.
 * `pathEnv` is the PATH of the process that admits the runners: a PTY child's
 * `env.PATH`, or `process.env.PATH` for a run in this process or in a child that
 * inherits it. A receipt binds the path that lookup reaches.
 */
export async function trustDeclaredRunners(
  input: Readonly<{
    projectDir: string;
    config: Config;
    pathEnv: string;
    stateDir?: string | undefined;
  }>,
): Promise<void> {
  const slots = [
    { role: 'planner' as const, runner: input.config.planner },
    { role: 'planner' as const, runner: resolveReviewerRunner(input.config).runner },
    ...resolveImplementerProfiles(input.config).profiles.map((profile) => ({
      role: 'implementer' as const,
      runner: profile.config,
    })),
  ];

  for (const slot of slots) {
    if (!isCustomCommandRunner(slot.runner)) continue;
    if (findConfiguredCustomCommand(input.config, slot.runner) !== undefined) continue;
    const command = inlineRunnerCommand({ runner: slot.runner, role: slot.role });
    const resolved = await resolveCustomExecutable({
      command: command.executable,
      projectDir: input.projectDir,
      pathEnv: input.pathEnv,
      pathExt: process.env.PATHEXT ?? '',
    });
    if (resolved.kind !== 'resolved') continue;
    await markCustomRunnerTrusted({
      projectDir: input.projectDir,
      runner: { source: 'inline', command },
      posture: inlineRunnerSecurityPosture(slot.role, command.contract),
      executable: resolved.executable,
      ...(input.stateDir === undefined ? {} : { stateDir: input.stateDir }),
    });
  }
}
