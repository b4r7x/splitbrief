import { resolveImplementerProfiles } from '../../src/core/config/accessors/implementer-profiles.js';
import {
  findConfiguredCustomCommand,
  inlineRunnerCommand,
  isCustomCommandRunner,
} from '../../src/core/config/custom-commands.js';
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
 */
export async function trustDeclaredRunners(
  input: Readonly<{
    projectDir: string;
    config: Config;
    stateDir?: string | undefined;
  }>,
): Promise<void> {
  const slots = [
    { role: 'planner' as const, runner: input.config.planner },
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
      pathEnv: process.env.PATH ?? '',
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
