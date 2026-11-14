import { readActiveRunner } from '../../../../core/config/accessors/active-runner.js';
import { readImplementerProfileConfig } from '../../../../core/config/accessors/implementer-profiles.js';
import type { RunnerConfig } from '../../../../core/config/accessors/runner-config.js';
import { loadConfig } from '../../../../core/config/load/io.js';
import type { CrewSeatId } from '../../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import type { Config } from '../../../../core/schemas/config.js';

type SeatOfRecordReadResult =
  | Readonly<{
      kind: 'read';
      seat: RunnerConfig | undefined;
      configRevision: string | undefined;
    }>
  | Readonly<{ kind: 'read-failed' }>;

/**
 * The halted seat as `config.yaml` has it now: a save under the halt, such as a custom model the
 * seat's picker added, is on it and the run config does not have it. A project with no config
 * file reads the run config.
 */
export function readSeatOfRecord(
  input: Readonly<{
    projectDir: string;
    seat: CrewSeatId;
    config: Config;
    implementerProfile?: string | undefined;
  }>,
): SeatOfRecordReadResult {
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(input.projectDir);
  } catch {
    return { kind: 'read-failed' };
  }
  const configOfRecord = loaded.revision === null ? input.config : loaded.config;
  const seat =
    input.seat === 'build'
      ? readImplementerProfileConfig(configOfRecord, input.implementerProfile)
      : readActiveRunner({ config: configOfRecord, role: CREW_SEAT_ROLES[input.seat] });
  return { kind: 'read', seat, configRevision: loaded.revision?.rawSha256 };
}
