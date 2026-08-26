import type { CliProviderAuthFact } from '../../../core/discovery/detection.js';
import type { AuthFact } from '../../../core/discovery/runner-evidence.js';
import {
  PROVIDER_ORACLE_TOOL_IDS,
  type CliToolId,
} from '../../../core/runners/cli-tool-catalog.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import type { CliProbeCommand, CliProbeOutput } from './contract.js';

type ProviderOracleToolId = (typeof PROVIDER_ORACLE_TOOL_IDS)[number];

/**
 * OpenCode and its Kilo fork ship a read-only per-provider credential listing
 * (`opencode providers list` is an alias of `opencode auth list`). Its output
 * names each stored credential (`oauth` / `api`) and each recognized
 * environment variable; it never prints credential values.
 */
const PROVIDER_ORACLE_COMMANDS: Readonly<
  Record<ProviderOracleToolId, readonly [string, ...string[]]>
> = {
  opencode: ['opencode', 'providers', 'list'],
  'kilo-code': ['kilo', 'auth', 'list'],
};

function isProviderOracleTool(tool: CliToolId): tool is ProviderOracleToolId {
  return PROVIDER_ORACLE_TOOL_IDS.some((id) => id === tool);
}

export function providerOracleCommand(tool: CliToolId): readonly [string, ...string[]] | undefined {
  return isProviderOracleTool(tool) ? PROVIDER_ORACLE_COMMANDS[tool] : undefined;
}

export function isProviderOracleProbe(
  input: Readonly<{ tool: CliToolId; command: CliProbeCommand }>,
): boolean {
  const oracle = providerOracleCommand(input.tool);
  return (
    oracle !== undefined &&
    input.command.command.length === oracle.length &&
    input.command.command.every((argument, index) => argument === oracle[index])
  );
}

export type ProviderOracleParse =
  | Readonly<{ kind: 'success'; entries: readonly CliProviderAuthFact[] }>
  | Readonly<{ kind: 'parse-failure' }>;

const PARSE_FAILURE: ProviderOracleParse = { kind: 'parse-failure' };
const MAX_ORACLE_ENTRIES = 64;

const LEADING_GLYPHS_PATTERN = /^[\s|*•─-╿■-◿]+/;
const CREDENTIALS_HEADER_PATTERN = /^Credentials\b/;
const ENVIRONMENT_HEADER_PATTERN = /^Environment\b/;
const CREDENTIALS_FOOTER_PATTERN = /^(\d+) credentials?$/;
const ENVIRONMENT_FOOTER_PATTERN = /^(\d+) environment variables?$/;
const CREDENTIAL_ENTRY_PATTERN = /^(.+?) +(oauth|api)$/;
const ENVIRONMENT_ENTRY_PATTERN = /^(.+?) +([A-Z][A-Z0-9_]*)$/;

/**
 * Parses the auth-list shape shared by both CLIs, tolerating ANSI styling,
 * box-drawing glyphs, and section reordering. Every unrecognized line and
 * every count mismatch resolves to a parse failure — never a throw — so the
 * caller can fall back instead of trusting a misread listing. Only provider
 * display names, source kinds, and env var names are captured.
 */
export function parseProviderOracleOutput(text: string): ProviderOracleParse {
  const entries: CliProviderAuthFact[] = [];
  let section: 'credentials' | 'environment' | undefined;
  let sawHeader = false;
  let credentialCount = 0;
  let environmentCount = 0;
  let expectedCredentials: number | undefined;
  let expectedEnvironment: number | undefined;

  for (const rawLine of stripTerminalControls(text, { preserveLineBreaks: true }).split('\n')) {
    const line = rawLine.replace(LEADING_GLYPHS_PATTERN, '').trim();
    if (line.length === 0) continue;
    if (CREDENTIALS_HEADER_PATTERN.test(line)) {
      section = 'credentials';
      sawHeader = true;
      continue;
    }
    if (ENVIRONMENT_HEADER_PATTERN.test(line)) {
      section = 'environment';
      sawHeader = true;
      continue;
    }
    const credentialsFooter = CREDENTIALS_FOOTER_PATTERN.exec(line);
    if (credentialsFooter?.[1] !== undefined) {
      expectedCredentials = Number(credentialsFooter[1]);
      continue;
    }
    const environmentFooter = ENVIRONMENT_FOOTER_PATTERN.exec(line);
    if (environmentFooter?.[1] !== undefined) {
      expectedEnvironment = Number(environmentFooter[1]);
      continue;
    }
    if (section === 'credentials') {
      const entry = CREDENTIAL_ENTRY_PATTERN.exec(line);
      if (entry?.[1] === undefined || (entry[2] !== 'oauth' && entry[2] !== 'api')) {
        return PARSE_FAILURE;
      }
      entries.push({ provider: entry[1].trim(), source: entry[2] });
      credentialCount += 1;
      continue;
    }
    if (section === 'environment') {
      const entry = ENVIRONMENT_ENTRY_PATTERN.exec(line);
      if (entry?.[1] === undefined || entry[2] === undefined) return PARSE_FAILURE;
      entries.push({ provider: entry[1].trim(), source: 'env', envVar: entry[2] });
      environmentCount += 1;
      continue;
    }
    return PARSE_FAILURE;
  }

  if (!sawHeader || entries.length > MAX_ORACLE_ENTRIES) return PARSE_FAILURE;
  if (expectedCredentials !== undefined && expectedCredentials !== credentialCount) {
    return PARSE_FAILURE;
  }
  if (expectedEnvironment !== undefined && expectedEnvironment !== environmentCount) {
    return PARSE_FAILURE;
  }
  return { kind: 'success', entries };
}

/** Strict contract-parser view of the oracle; three-way fallback lives in the readiness probe. */
export function providerOracleAuthFact(output: CliProbeOutput): AuthFact {
  const parsed = parseProviderOracleOutput(output.stdout);
  if (parsed.kind !== 'success') return 'malformed';
  return parsed.entries.length > 0 ? 'verified' : 'missing';
}
