import {
  CLI_AUTH_ENFORCEMENT_EVIDENCE,
  CLI_TOOL_CATALOG,
  isCliToolId,
  type CliAuthChannelId,
  type CliAuthEnforcementEvidence,
  type CliAuthMethod,
} from './cli-tool-catalog.js';

export type CliAuthSelectionInput = Readonly<{
  tool: string;
  platform: NodeJS.Platform;
  installedVersion: string | undefined;
  evidence?: readonly CliAuthEnforcementEvidence[];
}>;

export type CliHostConfiguredReason =
  | 'no-evidence'
  | 'platform-unproven'
  | 'version-unknown'
  | 'version-unproven';

/**
 * Whether a method choice may be offered for this exact installed adapter.
 * `host-configured` means the tool's own login and configuration decide.
 */
export type CliAuthMethodSelection =
  | Readonly<{
      kind: 'enforceable';
      channels: readonly [CliAuthMethod, ...CliAuthMethod[]];
      evidenceId: string;
    }>
  | Readonly<{ kind: 'host-configured'; reason: CliHostConfiguredReason }>
  | Readonly<{ kind: 'unsupported'; reason: 'not-admitted' }>;

export function deriveCliAuthSelection(input: CliAuthSelectionInput): CliAuthMethodSelection {
  const { tool, platform, installedVersion } = input;
  if (!isCliToolId(tool)) return { kind: 'unsupported', reason: 'not-admitted' };

  const rows = (input.evidence ?? CLI_AUTH_ENFORCEMENT_EVIDENCE).filter((row) => row.tool === tool);
  if (rows.length === 0) return { kind: 'host-configured', reason: 'no-evidence' };
  if (installedVersion === undefined) return { kind: 'host-configured', reason: 'version-unknown' };

  const platformRows = rows.filter((row) => row.platform === platform);
  if (platformRows.length === 0) return { kind: 'host-configured', reason: 'platform-unproven' };

  const row = platformRows.find((candidate) => candidate.installedVersion === installedVersion);
  if (row === undefined) return { kind: 'host-configured', reason: 'version-unproven' };

  const declared = CLI_TOOL_CATALOG[tool].auth.channels;
  const [first, ...rest] = row.channels.filter((method) =>
    declared.some((channel) => channel.id === method),
  );
  if (first === undefined) return { kind: 'host-configured', reason: 'no-evidence' };
  return { kind: 'enforceable', channels: [first, ...rest], evidenceId: row.id };
}

export type CliAuthAdmission =
  | Readonly<{ kind: 'host-configured' }>
  | Readonly<{ kind: 'enforced'; channel: CliAuthMethod; evidenceId: string }>
  | Readonly<{ kind: 'refused'; channel: CliAuthMethod; message: string }>;

/**
 * The dispatch rule for a runner's raw `authChannel`. An omitted or
 * provider-dependent channel is host-configured and may run. An explicit
 * `session` or `api-key` is a method request: it runs only with current proof
 * for this adapter, platform and version, and is otherwise refused before
 * dispatch — never reinterpreted as host-configured.
 */
export function admitCliAuthChannel(
  input: CliAuthSelectionInput & Readonly<{ authChannel: CliAuthChannelId | undefined }>,
): CliAuthAdmission {
  const channel = input.authChannel;
  if (channel === undefined || channel === 'provider-dependent') return { kind: 'host-configured' };

  const selection = deriveCliAuthSelection(input);
  if (selection.kind === 'enforceable' && selection.channels.includes(channel)) {
    return { kind: 'enforced', channel, evidenceId: selection.evidenceId };
  }
  const version = input.installedVersion ?? 'unknown version';
  return {
    kind: 'refused',
    channel,
    message: `authChannel "${channel}" cannot be enforced for CLI tool "${input.tool}" (${version} on ${input.platform}), so it will not run on a method it cannot guarantee. Remove authChannel from this runner to let the tool's own login decide.`,
  };
}

/**
 * The runner a method choice writes. Choosing host configuration removes the
 * field instead of persisting the tool's default channel as the user's choice.
 */
export function applyCliAuthChoice<
  Runner extends Readonly<{ authChannel?: CliAuthChannelId | undefined }>,
>(
  runner: Runner,
  choice: CliAuthMethod | 'host-configured',
): Omit<Runner, 'authChannel'> & { authChannel?: CliAuthMethod } {
  const { authChannel: _previous, ...rest } = runner;
  return choice === 'host-configured' ? rest : { ...rest, authChannel: choice };
}
