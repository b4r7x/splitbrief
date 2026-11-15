import type { RunnerBillingPosture } from '../billing.js';

export const CLI_AUTH_CHANNEL_IDS = Object.freeze([
  'api-key',
  'session',
  'provider-dependent',
] as const);

export type CliAuthChannelId = (typeof CLI_AUTH_CHANNEL_IDS)[number];

export type CliAuthChannel = Readonly<{
  id: CliAuthChannelId;
  env: readonly string[];
  billing: RunnerBillingPosture;
  /**
   * Platforms where this channel's credential is an OS keychain item rather
   * than a file, so the file-copying state bridge has nothing to carry. macOS
   * keeps the Claude Code, Cursor Agent CLI, Antigravity and GitHub Copilot CLI
   * sessions in the login keychain, whose default search list resolves through
   * `HOME`. Claude Code keys its item on the account name in `USER`; Cursor's
   * items use the fixed account `cursor-user`. A staged child reaches the item
   * only when `HOME` (and `USER` for Claude Code) keep their host values.
   */
  hostKeychainPlatforms: readonly NodeJS.Platform[];
  /** Platforms with an admitted credential bridge; omitted when no restriction is known. */
  supportedPlatforms?: readonly NodeJS.Platform[];
}>;

/**
 * How a channel's host credential reaches a staged child.
 *
 * - `none` — no channel: an API runner or a version probe carries no host state.
 * - `bridged-files` — a read-only snapshot of this tool's own credential files
 *   is copied into the sandbox, whose `HOME` the child keeps.
 * - `host-account` — the credential is an OS keychain item, so nothing is
 *   copied and the child keeps the host `HOME` and `USER` instead.
 */
export type CliHostStateAccess = 'none' | 'bridged-files' | 'host-account';

export function cliAuthChannelHostStateAccess(
  channel: CliAuthChannel,
  platform: NodeJS.Platform = process.platform,
): Exclude<CliHostStateAccess, 'none'> {
  return channel.hostKeychainPlatforms.includes(platform) ? 'host-account' : 'bridged-files';
}

export function cliAuthChannelPlatformSupported(
  channel: CliAuthChannel,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return channel.supportedPlatforms?.includes(platform) ?? true;
}

export type CliAuthChannels = readonly [CliAuthChannel, ...CliAuthChannel[]];

export type CliAuthPolicy = Readonly<{
  kind: 'session' | 'provider-dependent';
  env: readonly string[];
  channels: CliAuthChannels;
}>;
