import type { z } from 'zod';
import type { CliReadinessStateSchema } from '../discovery/detection/tool.js';
import {
  cliAuthChannelPlatformSupported,
  cliAuthChannelHostStateAccess,
} from '../runners/cli-tool/auth-channels.js';
import { CLI_TOOL_CATALOG, defaultCliAuthChannel } from '../runners/cli-tool/catalog.js';
import {
  type CliReadinessFacts,
  type CliReadinessResult,
  CliReadinessFactsSchema,
  deriveCliReadinessStatus,
  cliReadinessCheckId,
} from '../schemas/readiness.js';

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

function platformName(platform: NodeJS.Platform): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

/**
 * Where the user checks a tool again: `doctor` checks a saved crew, inside the runner picker
 * `ctrl+r` checks the tools again, and Setup reaches that picker through `⏎` on a seat.
 */
export type CliRecheck = 'doctor' | 'picker' | 'setup';

/** The step every remediation ends on, spelled from where the user is. */
export function thenRecheck(recheck: CliRecheck): string {
  switch (recheck) {
    case 'doctor':
      return 'then run `splitbrief doctor` again';
    case 'picker':
      return 'then ctrl+r';
    case 'setup':
      return 'then ⏎ on a seat and ctrl+r';
  }
}

/** The sign-in step every surface gives a signed-out tool; `names` is one tool or a list of them. */
export function cliSignInStep(names: string, recheck: CliRecheck): string {
  return `Sign in to ${names}, ${thenRecheck(recheck)}.`;
}

export function cliAuthRemediation(tool: CliReadinessFacts['tool'], recheck: CliRecheck): string {
  const name = CLI_TOOL_CATALOG[tool].displayName;
  const channel = defaultCliAuthChannel(tool);
  if (!cliAuthChannelPlatformSupported(channel)) {
    const supported = channel.supportedPlatforms?.map(platformName).join(', ');
    return `${name} ${channel.id} authentication is not supported on ${platformName(process.platform)}. Choose another tool in Settings > Crew, or use ${supported}.`;
  }
  const credentialEnv = channel.env[0];
  if (credentialEnv !== undefined) {
    return `Export ${credentialEnv} for ${name}, ${thenRecheck(recheck)}.`;
  }
  const signIn = cliSignInStep(name, recheck);
  // The picker byline keeps one row for the remedy and the next for the tool's facts or its
  // failure, so it gives the step alone; doctor has the room to say where SPLITBRIEF looks.
  if (recheck === 'picker') return signIn;
  switch (cliAuthChannelHostStateAccess(channel)) {
    case 'host-account':
      return `SPLITBRIEF looks for the ${name} session in the ${platformName(process.platform)} keychain. ${signIn}`;
    case 'bridged-files':
      return `SPLITBRIEF looks for the ${name} session in its session files. ${signIn}`;
  }
}

export const UNVERIFIED_AUTH_FIX =
  'Run SPLITBRIEF in a terminal to review the sign-in warning, or pass --allow-unverified-auth to start without confirming sign-in.';

/** A Codex sign-in kept in the system keyring, the headline wherever that state shows. */
export const CODEX_KEYRING_SIGN_IN = `${CLI_TOOL_CATALOG.codex.displayName} keeps its sign-in in the system keyring, which a run cannot reach.`;

/** The step that moves a Codex keyring sign-in to the file a run reads. */
export function codexKeyringSignInFix(recheck: CliRecheck): string {
  return `Set cli_auth_credentials_store = "file" in config.toml and run codex login again, ${thenRecheck(recheck)}.`;
}

export function cliExecutableTrustRemediation(name: string, recheck: CliRecheck): string {
  return `Install ${name} outside the project. Put its absolute directory first on PATH, ${thenRecheck(recheck)}.`;
}

export function cliReadinessRemediation(
  facts: Pick<CliReadinessFacts, 'tool' | 'installedVersion' | 'testedVersion' | 'compatibility'> &
    Partial<Pick<CliReadinessFacts, 'auth'>>,
  status: Exclude<z.infer<typeof CliReadinessStateSchema>, 'ready'>,
  recheck: CliRecheck,
): string {
  const name = CLI_TOOL_CATALOG[facts.tool].displayName;
  switch (status) {
    case 'disabled':
      return `Enable ${name} before selecting it as a runner.`;
    case 'unavailable':
      return `Install ${name}, ${thenRecheck(recheck)}.`;
    case 'untrusted':
      return cliExecutableTrustRemediation(name, recheck);
    case 'incompatible':
      return `Install the tested ${name} version (${facts.testedVersion}), ${thenRecheck(recheck)}.`;
    case 'unverified':
      if (facts.compatibility === 'timeout') {
        return `Run \`${CLI_TOOL_CATALOG[facts.tool].command} --version\` in a terminal and wait for it to finish, ${thenRecheck(recheck)}.`;
      }
      if (facts.installedVersion === null || facts.compatibility !== 'compatible') {
        return `Verify ${name} against tested version ${facts.testedVersion}, ${thenRecheck(recheck)}.`;
      }
      if (!cliAuthChannelPlatformSupported(defaultCliAuthChannel(facts.tool)))
        return cliAuthRemediation(facts.tool, recheck);
      // Honest about the ceiling of a cheap check: stored credentials prove
      // presence, never a working session, and re-running readiness cannot
      // change that — only a real call can.
      return `If a call to ${name} fails to authenticate, sign in again. Stored credentials do not prove a session; only a real call does.`;
    case 'unauthenticated':
      if (facts.auth === 'keyring') return codexKeyringSignInFix(recheck);
      return cliAuthRemediation(facts.tool, recheck);
  }
}

export function deriveCliReadiness(input: CliReadinessFacts): CliReadinessResult {
  const facts = CliReadinessFactsSchema.parse(input);
  const status = deriveCliReadinessStatus(facts);
  const checkId = cliReadinessCheckId(facts.tool);
  if (status === 'ready') return { ...facts, checkId, status, remediation: null };
  return {
    ...facts,
    checkId,
    status,
    remediation: cliReadinessRemediation(facts, status, 'doctor'),
  };
}
