import { join } from 'node:path';
import { clearStaleSession } from '../../../core/sessions/guards.js';
import { beginSession } from '../../../core/sessions/lifecycle.js';
import { sessionError } from '../../../core/sessions/errors.js';
import { collectReadiness } from '../../../core/readiness/collect.js';
import {
  createStartReadinessRecord,
  formatReadinessBlockers,
  readinessBlockerPointer,
} from '../../../core/readiness/format.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { READINESS_FILE, sessionDir } from '../../../core/paths.js';
import { writeSecureFile } from '../../../lib/fs.js';
import { cliError } from '../../errors.js';
import { cliStartGatesFromReadiness } from '../../../engine/runners/start-gate.js';
import { detectAvailableCliReadiness } from '../../../engine/detection/detect.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import type { Config } from '../../../core/schemas/config.js';
import {
  CLI_TOOL_IDS,
  type CliAuthChannelId,
  type CliToolId,
} from '../../../core/runners/cli-tool-catalog.js';
import type { BootstrapSessionArgs, BootstrapSessionResult, DetectCliReadiness } from './types.js';

/**
 * Build one auth-channel selection per configured CLI tool. A conflicting
 * channel used by two roles is intentionally left unselected so the probe
 * cannot accidentally authorize either role through an ambient credential.
 */
function configuredCliAuthChannels(
  config: Config,
): Partial<Record<CliToolId, CliAuthChannelId | undefined>> {
  const selections = new Map<CliToolId, CliAuthChannelId | undefined>();
  const add = (tool: CliToolId, channel: CliAuthChannelId | undefined): void => {
    if (!selections.has(tool)) {
      selections.set(tool, channel);
      return;
    }
    if (selections.get(tool) !== channel) selections.set(tool, undefined);
  };

  if (config.planner.kind === 'cli') add(config.planner.tool, config.planner.authChannel);
  try {
    for (const profile of resolveImplementerProfiles(config).profiles) {
      if (profile.config.kind === 'cli') add(profile.config.tool, profile.config.authChannel);
    }
  } catch {
    // Config readiness reports the invalid profile. Do not probe a guessed
    // tool/channel when the profile boundary cannot be resolved.
  }

  return Object.fromEntries(selections);
}

/**
 * Start-only detector. It deliberately skips the detection cache and probes
 * exactly the configured CLI tools through the canonical resolver/probe path.
 */
export const detectConfiguredCliReadiness: DetectCliReadiness = async ({ projectDir, config }) => {
  const authChannels = configuredCliAuthChannels(config);
  const tools = CLI_TOOL_IDS.filter((tool) => Object.hasOwn(authChannels, tool));
  if (tools.length === 0) return [];
  return detectAvailableCliReadiness({ projectDir, tools, authChannels });
};

export function persistStartReadiness(ref: SessionRef, report: ReadinessReport): void {
  const record = createStartReadinessRecord(report);
  writeSecureFile(
    join(sessionDir(ref.projectDir, ref.sessionId), READINESS_FILE),
    JSON.stringify(record, null, 2) + '\n',
  );
}

export function assertReadinessCanStart(report: ReadinessReport, json: boolean | undefined): void {
  if (report.status !== 'blocked') return;
  if (!json) console.log(formatReadinessBlockers(report));
  throw cliError(readinessBlockerPointer(report), 1);
}

export function clearStaleSessionForCli(projectDir: string): void {
  try {
    clearStaleSession(projectDir);
  } catch (err) {
    if (sessionError.isStillActive(err)) {
      throw cliError(err.message, 1);
    }
    throw err;
  }
}

export async function bootstrapSession(
  args: BootstrapSessionArgs,
): Promise<BootstrapSessionResult> {
  const readiness = await collectReadiness({
    projectDir: args.projectDir,
    opts: args.opts,
    probeValidation: true,
    ...(args.defaultAutoApprove !== undefined && { defaultAutoApprove: args.defaultAutoApprove }),
    ...(args.cliReadiness !== undefined && { cliReadiness: args.cliReadiness }),
    ...(args.detectCliReadiness !== undefined && {
      detectCliReadiness: args.detectCliReadiness,
    }),
  });
  args.emitReadiness(readiness.report);
  assertReadinessCanStart(readiness.report, args.assertJson);
  clearStaleSessionForCli(args.projectDir);
  const persistTranscript = readiness.config?.workflow.persistTranscript ?? true;
  const sessionId = beginSession(args.projectDir, args.feature, { persistTranscript });
  persistStartReadiness({ projectDir: args.projectDir, sessionId }, readiness.report);
  return {
    sessionId,
    readiness,
    trustedCliGates: cliStartGatesFromReadiness(readiness.cliReadiness),
  };
}
