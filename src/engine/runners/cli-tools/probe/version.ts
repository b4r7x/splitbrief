import { CLI_TOOL_CATALOG } from '../../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../../core/runners/cli-tool/types.js';
import type { CliProbeOutput } from './contract.js';

export const PROBE_OUTPUT_MAX_BYTES = 4_096;
export const PROVIDER_ORACLE_OUTPUT_MAX_BYTES = 16_384;
const SEMVER_PATTERN =
  '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const CALVER_PATTERN = '\\d{4}\\.\\d{2}\\.\\d{2}(?:-[A-Za-z0-9]+)?';
const BARE_CALVER = new RegExp(`^${CALVER_PATTERN}$`);
const ANY_CALVER = new RegExp(CALVER_PATTERN, 'g');

type VersionOutputFormat =
  | Readonly<{ kind: 'bare' }>
  | Readonly<{
      kind: 'labeled';
      labels: readonly string[];
      bareDescriptorSuffix?: string | undefined;
      allowTrailingPeriod?: boolean | undefined;
      allowBare?: boolean | undefined;
    }>;

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function versionOutputFormat(tool: CliToolId, command: string): VersionOutputFormat {
  switch (tool) {
    // `codex --version` currently reports `codex-cli <version>`, while older
    // releases reported `codex <version>`; both are descriptor-owned forms.
    case 'codex':
      return { kind: 'labeled', labels: [command, 'codex-cli'] };
    // opencode 2 reports `opencode v<version>`; releases below 2.0.0 print
    // the bare version.
    case 'opencode':
      return { kind: 'labeled', labels: [command], allowBare: true };
    // These CLIs deliberately expose a bare version as their documented
    // version contract. The whole line must be the one semver token.
    case 'kilo-code':
    case 'command-code':
      return { kind: 'bare' };
    case 'cursor':
      return { kind: 'bare' };
    case 'claude-code':
      return {
        kind: 'labeled',
        labels: [command, 'claude code'],
        bareDescriptorSuffix: 'Claude Code',
      };
    case 'copilot':
      return {
        kind: 'labeled',
        labels: [command, 'GitHub Copilot CLI'],
        allowTrailingPeriod: true,
      };
    case 'antigravity':
      return { kind: 'bare' };
  }
}

function parseCalverVersion(output: CliProbeOutput) {
  const outputText = `${output.stdout}\n${output.stderr}`;
  const lineMatches = outputText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const match = BARE_CALVER.exec(line);
      return match === null ? [] : [match[0]];
    });
  const allCalverCandidates = [...outputText.matchAll(ANY_CALVER)];
  const candidate = lineMatches[0];
  return lineMatches.length === 1 && allCalverCandidates.length === 1 && candidate !== undefined
    ? { kind: 'success' as const, value: candidate }
    : { kind: 'malformed' as const };
}

export function parseVersion(tool: CliToolId, command: string, output: CliProbeOutput) {
  if (CLI_TOOL_CATALOG[tool].compatibility.versionScheme === 'calver') {
    return parseCalverVersion(output);
  }
  const format = versionOutputFormat(tool, command);
  const bareLine = new RegExp(`^v?(${SEMVER_PATTERN})$`, 'i');
  const matchers =
    format.kind === 'bare'
      ? [bareLine]
      : [
          new RegExp(
            `^(?:${format.labels.map(escapeRegularExpression).join('|')})\\s+(?:version\\s+)?v?(${SEMVER_PATTERN})${format.allowTrailingPeriod ? '\\.?' : ''}$`,
            'i',
          ),
          ...(format.bareDescriptorSuffix === undefined
            ? []
            : [
                new RegExp(
                  `^v?(${SEMVER_PATTERN})\\s+\\(${escapeRegularExpression(format.bareDescriptorSuffix)}\\)$`,
                  'i',
                ),
              ]),
          ...(format.allowBare ? [bareLine] : []),
        ];
  const outputText = `${output.stdout}\n${output.stderr}`;
  const candidates = outputText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const candidate = matchers
        .map((matcher) => matcher.exec(line)?.[1])
        .find((value): value is string => value !== undefined);
      return candidate === undefined ? [] : [candidate];
    });
  const allSemverCandidates = [
    ...outputText.matchAll(
      new RegExp(`(?:^|[^0-9A-Za-z.-])v?(${SEMVER_PATTERN})(?=$|[^0-9A-Za-z-]|\\.(?!\\d))`, 'gim'),
    ),
  ];

  // A catalog may run only after one descriptor-specific version line. This
  // rejects dependency banners, wrong tool labels, duplicate/conflicting
  // values, and an otherwise admitted descriptor line accompanied by a
  // second incompatible runtime/dependency version.
  const candidate = candidates[0];
  return candidates.length === 1 && allSemverCandidates.length === 1 && candidate !== undefined
    ? { kind: 'success' as const, value: candidate }
    : { kind: 'malformed' as const };
}
