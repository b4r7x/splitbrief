import {
  nativeCliCatalogToDetectedModels,
  parseAntigravityModelCatalog,
  parseCodexNativeModelCatalog,
  parseCommandCodeNativeModelCatalog,
  parseCopilotHelpConfigCatalog,
  parseCursorNativeModelCatalog,
  parseKiloNativeModelCatalog,
  parseOpenCodeNativeModelCatalog,
  parseOpenCodeVerboseModelCatalog,
  type NativeCliModelCatalog,
} from '../../providers/cli-model-catalog.js';
import {
  CLI_TOOL_CATALOG,
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
  type CliToolId,
} from '../../../core/runners/cli-tool-catalog.js';
import type { DetectedModel } from '../../../core/discovery/detection.js';
import type { RunnerRole } from '../../../core/runners/seat-roles.js';
import type { PlannerCliToolId, ImplementerCliToolId } from '../../../core/schemas/enums.js';
import { includes, isRecord } from '../../../utils/type-guards.js';
import { DISCOVERY_SUBPROCESS_TIMEOUT_MS } from '../../constants.js';
import { runnerConfigError } from '../errors.js';
import type { PromptLimit } from '../input-limit.js';
import { antigravityImplementerAdapter, antigravityPlannerAdapter } from './antigravity.js';
import { claudeCodeImplementerAdapter, claudeCodePlannerAdapter } from './claude-code.js';
import { codexImplementerAdapter, codexPlannerAdapter } from './codex.js';
import { CODEX_NATIVE_MODEL_CATALOG_PROBE } from './codex.js';
import { commandCodeImplementerAdapter, commandCodePlannerAdapter } from './command-code.js';
import { copilotImplementerAdapter, copilotPlannerAdapter } from './copilot.js';
import { cursorImplementerAdapter, cursorPlannerAdapter } from './cursor.js';
import { kiloImplementerAdapter, kiloPlannerAdapter } from './kilo-code.js';
import { opencodeImplementerAdapter, opencodePlannerAdapter } from './opencode.js';
import {
  providerOracleAuthFact,
  providerOracleCommand,
  providerOracleLegacyCommand,
} from './provider-oracle.js';
import type {
  CliAuthProbe,
  CliCatalogProbe,
  CliDeclaredProbeContract,
  CliImplementerAdapter,
  CliPlannerAdapter,
  CliProbeCommand,
  CliProbeContract,
  CliProbeOutput,
  CliProbeParser,
  CliVersionProbe,
} from './contract.js';

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_MAX_BYTES = 4_096;
const PROVIDER_ORACLE_TIMEOUT_MS = 10_000;
const PROVIDER_ORACLE_OUTPUT_MAX_BYTES = 16_384;
// `agy models` waits on Google's loadCodeAssist and fetchAvailableModels before
// it lists, and at times on a user-info call before it exits. agy's own logs put
// 388 of 394 readiness listings under 5 s; the rest took 5.9 s, 7.0 s, 11.4 s
// and longer, and the shared 5 s budget read each one as an unadmitted runner.
// The probe ceiling caps this budget at 10 s.
const ANTIGRAVITY_MODELS_TIMEOUT_MS = DISCOVERY_SUBPROCESS_TIMEOUT_MS;
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

function parseVersion(tool: CliToolId, command: string, output: CliProbeOutput) {
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

function jsonAuthFact(output: CliProbeOutput): ReturnType<typeof authFactFromText> | undefined {
  const text = output.stdout.trim();
  if (text.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    if (parsed.loggedIn === true || parsed.authenticated === true) return 'verified';
    if (parsed.loggedIn === false || parsed.authenticated === false) return 'missing';
    return typeof parsed.status === 'string' ? authFactFromText(parsed.status) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The words a runner uses when it could not reach the network at all. Shared
 * with the seat-trouble classifier: an unreachable endpoint is a fact about the
 * machine and is retried, so it must never be read as an auth fact either.
 */
const OFFLINE_TEXT_MARKERS: readonly string[] = ['offline', 'network', 'connection refused', 'dns'];

export function looksOfflineDiagnostic(value: string): boolean {
  const text = value.trim().toLowerCase();
  return OFFLINE_TEXT_MARKERS.some((marker) => text.includes(marker));
}

function authFactFromText(value: string) {
  const text = value.trim().toLowerCase();
  if (text.length === 0) return undefined;
  // Negated forms come first: `not authenticated` and `not signed in` contain
  // the positive tokens the verified arm matches on.
  if (
    text.includes('not logged in') ||
    text.includes('not authenticated') ||
    text.includes('not signed in') ||
    text.includes('no active session') ||
    text.includes('unauthenticated') ||
    text.includes('no credential') ||
    text.includes('missing credential')
  ) {
    return 'missing' as const;
  }
  if (
    text.includes('logged in') ||
    text.includes('logged_in') ||
    text.includes('authenticated') ||
    text.includes('auth mode')
  ) {
    return 'verified' as const;
  }
  if (
    text.includes('invalid') ||
    text.includes('expired') ||
    text.includes('unauthorized') ||
    text.includes('authentication failed')
  ) {
    return 'invalid' as const;
  }
  if (text.includes('policy') || text.includes('forbidden') || text.includes('access denied')) {
    return 'policy-denied' as const;
  }
  if (looksOfflineDiagnostic(text)) return 'offline' as const;
  return undefined;
}

// A positive local status proves a credential is present; liveness is established
// by the first real call, which carries its own failure remediation.
function parseStatusAuth(output: CliProbeOutput) {
  const fromJson = jsonAuthFact(output);
  if (fromJson !== undefined) return fromJson;
  return authFactFromText(`${output.stdout}\n${output.stderr}`) ?? 'malformed';
}

// `cmd` exits 3 for "not authenticated" even when it prints nothing; every
// other code falls through to the shared status parsing.
function parseCommandCodeStatusAuth(output: CliProbeOutput) {
  if (output.exitCode === 3) return 'missing' as const;
  return parseStatusAuth(output);
}

function declaredAuthProbe(tool: CliToolId, command: string): CliAuthProbe {
  switch (tool) {
    case 'claude-code':
      return {
        kind: 'auth-status',
        command: [command, 'auth', 'status'],
        cwd: 'neutral',
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: PROBE_OUTPUT_MAX_BYTES,
        parse: parseStatusAuth,
      };
    case 'codex':
      return {
        kind: 'auth-status',
        command: [command, 'login', 'status'],
        cwd: 'neutral',
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: PROBE_OUTPUT_MAX_BYTES,
        parse: parseStatusAuth,
      };
    // OpenCode and Kilo expose a read-only per-provider credential listing
    // that names each stored credential and recognized env var without ever
    // printing values. When its output cannot be parsed, the readiness probe
    // falls back to allowlisted-state presence.
    case 'opencode':
    case 'kilo-code': {
      const oracle = providerOracleCommand(tool);
      if (oracle === undefined) return { kind: 'not-run' };
      const legacy = providerOracleLegacyCommand(tool);
      return {
        kind: 'auth-status',
        command: oracle,
        cwd: 'neutral',
        timeoutMs: PROVIDER_ORACLE_TIMEOUT_MS,
        maxOutputBytes: PROVIDER_ORACLE_OUTPUT_MAX_BYTES,
        parse: providerOracleAuthFact,
        ...(legacy === undefined ? {} : { legacy }),
      };
    }
    case 'cursor':
      return {
        kind: 'auth-status',
        command: [command, 'status'],
        cwd: 'neutral',
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: PROBE_OUTPUT_MAX_BYTES,
        parse: parseStatusAuth,
      };
    // Every `cmd` start checks for an update in the background and spawns a
    // detached installer unless the argv names `--no-auto-update`. The status
    // and listing probes wait on the network long enough for that check to
    // land (cmd went 1.62.1 -> 1.64.0 under a listing probe), so both carry it.
    case 'command-code':
      return {
        kind: 'auth-status',
        command: [command, 'status', '--json', '--no-auto-update'],
        cwd: 'neutral',
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: PROBE_OUTPUT_MAX_BYTES,
        parse: parseCommandCodeStatusAuth,
      };
    case 'antigravity':
      return {
        kind: 'auth-status',
        command: [command, 'models'],
        cwd: 'neutral',
        timeoutMs: ANTIGRAVITY_MODELS_TIMEOUT_MS,
        maxOutputBytes: PROBE_OUTPUT_MAX_BYTES,
        // `agy models` needs a signed-in account to list anything, so a
        // non-zero exit is the missing-credential answer.
        parse: (output) => (output.exitCode === 0 ? 'verified' : 'missing'),
      };
    case 'copilot':
      return { kind: 'not-run' };
  }
}

type NativeCatalogParser = (stdout: string) => NativeCliModelCatalog | null;

/**
 * Registry declarations are execution policy, not a convenient view of the
 * adapter. Copy each tuple before freezing so an adapter module (or an
 * imported catalog descriptor) cannot retain a mutable alias to argv.
 */
function ownedProbeCommand(
  command: readonly [string, ...string[]],
): readonly [string, ...string[]] {
  return Object.freeze([command[0], ...command.slice(1)] as [string, ...string[]]);
}

function frozenParser<Parser extends object>(parser: Parser): Parser {
  return Object.freeze(parser);
}

function frozenProbeCommand(probe: CliProbeCommand): CliProbeCommand {
  return Object.freeze({ ...probe, command: ownedProbeCommand(probe.command) });
}

function frozenVersionProbe(probe: CliVersionProbe): CliVersionProbe {
  return Object.freeze({
    ...probe,
    command: ownedProbeCommand(probe.command),
    parse: frozenParser(probe.parse),
  });
}

function frozenAuthProbe(probe: CliAuthProbe): CliAuthProbe {
  if (probe.kind === 'not-run') return Object.freeze({ kind: 'not-run' as const });
  return Object.freeze({
    ...probe,
    command: ownedProbeCommand(probe.command),
    ...(probe.legacy === undefined
      ? {}
      : {
          legacy: Object.freeze({
            ...probe.legacy,
            command: ownedProbeCommand(probe.legacy.command),
          }),
        }),
    parse: frozenParser(probe.parse),
  });
}

function frozenCatalogProbe(probe: CliCatalogProbe): CliCatalogProbe {
  if (probe.kind === 'not-run') return Object.freeze({ kind: 'not-run' as const });
  return Object.freeze({
    ...probe,
    command: ownedProbeCommand(probe.command),
    ...(probe.manualCommand === undefined
      ? {}
      : { manualCommand: ownedProbeCommand(probe.manualCommand) }),
    parse: frozenParser(probe.parse),
  });
}

function frozenDeclaredProbe(probe: CliDeclaredProbeContract): CliDeclaredProbeContract {
  return Object.freeze({
    kind: 'declared' as const,
    version: frozenVersionProbe(probe.version),
    auth: frozenAuthProbe(probe.auth),
    catalog: frozenCatalogProbe(probe.catalog),
  });
}

function frozenProbeContract(
  probe: CliProbeContract,
  declared: CliDeclaredProbeContract,
): CliProbeContract {
  return Object.freeze({
    version: frozenProbeCommand(probe.version),
    auth: frozenProbeCommand(probe.auth),
    declared: frozenDeclaredProbe(declared),
  });
}

function catalogParse(parser: NativeCatalogParser): CliProbeParser<readonly DetectedModel[]> {
  return (output) => {
    const catalog = parser(output.stdout);
    return catalog === null
      ? { kind: 'malformed' }
      : { kind: 'success', value: nativeCliCatalogToDetectedModels(catalog) };
  };
}

function structuralCatalogProbe(
  input: Readonly<{
    command: readonly [string, ...string[]];
    parser: NativeCatalogParser;
    manualCommand?: readonly [string, ...string[]] | undefined;
    hostState?: 'host-account' | undefined;
    directoryHeader?: 'x-opencode-directory' | undefined;
    timeoutMs?: number | undefined;
    legacy?: Readonly<{
      belowVersion: string;
      command: readonly [string, ...string[]];
      manualCommand?: readonly [string, ...string[]] | undefined;
      parser: NativeCatalogParser;
    }>;
  }>,
): Exclude<CliCatalogProbe, { kind: 'not-run' }> {
  const command = ownedProbeCommand(input.command);
  const manualCommand =
    input.manualCommand === undefined ? undefined : ownedProbeCommand(input.manualCommand);
  return {
    kind: 'catalog',
    command,
    cwd: 'neutral',
    timeoutMs: input.timeoutMs ?? CODEX_NATIVE_MODEL_CATALOG_PROBE.timeoutMs,
    maxOutputBytes: CODEX_NATIVE_MODEL_CATALOG_PROBE.maxOutputBytes,
    ...(manualCommand === undefined ? {} : { manualCommand }),
    ...(input.hostState === undefined ? {} : { hostState: input.hostState }),
    ...(input.directoryHeader === undefined ? {} : { directoryHeader: input.directoryHeader }),
    ...(input.legacy === undefined
      ? {}
      : {
          legacy: {
            belowVersion: input.legacy.belowVersion,
            command: ownedProbeCommand(input.legacy.command),
            ...(input.legacy.manualCommand === undefined
              ? {}
              : { manualCommand: ownedProbeCommand(input.legacy.manualCommand) }),
            parse: catalogParse(input.legacy.parser),
          },
        }),
    parse: catalogParse(input.parser),
  };
}

function declaredCatalogProbe(tool: CliToolId): CliCatalogProbe {
  switch (tool) {
    case 'codex':
      return structuralCatalogProbe({
        command: CODEX_NATIVE_MODEL_CATALOG_PROBE.command,
        parser: parseCodexNativeModelCatalog,
      });
    case 'opencode':
      return structuralCatalogProbe({
        command: ['opencode', 'api', 'GET', '/api/model'],
        // opencode 2 serves `model.list` from its own server, which materializes
        // a directory's providers on first sight and cannot see an `env`-type
        // provider connection the sandbox strips. See docs/AUTH-METHOD-MATRIX.md.
        hostState: 'host-account',
        // Without the header the server lists the global providers only, none that
        // the project's own opencode.json sets up.
        directoryHeader: 'x-opencode-directory',
        parser: parseOpenCodeNativeModelCatalog,
        // 2.x has no refresh flag — `opencode models` takes only `--standalone`
        // and `--server` — so a manual refresh re-runs this GET, which is a real
        // refresh: the server rebuilds its snapshot reactively and answers live.
        legacy: {
          belowVersion: '2.0.0',
          command: ['opencode', 'models', '--verbose'],
          manualCommand: ['opencode', 'models', '--verbose', '--refresh'],
          parser: parseOpenCodeVerboseModelCatalog,
        },
      });
    case 'kilo-code':
      return structuralCatalogProbe({
        command: ['kilo', 'models', '--verbose'],
        manualCommand: ['kilo', 'models', '--verbose', '--refresh'],
        parser: parseKiloNativeModelCatalog,
        // Each probe starts kilo in a fresh sandbox home, where it migrates its
        // database and downloads an 11 MB cache before it lists: 1.7 s idle,
        // 3.8 s measured under ordinary desktop load, past 5 s at TUI startup.
        timeoutMs: DISCOVERY_SUBPROCESS_TIMEOUT_MS,
      });
    case 'cursor':
      return structuralCatalogProbe({
        command: ['cursor-agent', '--list-models'],
        parser: parseCursorNativeModelCatalog,
      });
    case 'command-code':
      return structuralCatalogProbe({
        command: ['cmd', '--list-models', '--no-auto-update'],
        parser: parseCommandCodeNativeModelCatalog,
      });
    case 'copilot':
      return structuralCatalogProbe({
        command: ['copilot', 'help', 'config'],
        parser: parseCopilotHelpConfigCatalog,
      });
    case 'antigravity':
      return structuralCatalogProbe({
        command: ['agy', 'models'],
        parser: parseAntigravityModelCatalog,
        timeoutMs: ANTIGRAVITY_MODELS_TIMEOUT_MS,
      });
    case 'claude-code':
      return { kind: 'not-run' };
  }
}

function declaredProbe(
  adapter: CliPlannerAdapter | CliImplementerAdapter,
): CliDeclaredProbeContract {
  const tool = adapter.descriptor.id;
  const command = adapter.descriptor.command;
  const version: CliVersionProbe = {
    ...adapter.probe.version,
    kind: 'version',
    parse: (output) => parseVersion(tool, command, output),
  };
  return {
    kind: 'declared',
    version,
    auth: declaredAuthProbe(tool, command),
    catalog: declaredCatalogProbe(tool),
  };
}

function withDeclaredPlannerProbe(adapter: CliPlannerAdapter): CliPlannerAdapter {
  const declared = declaredProbe(adapter);
  return Object.freeze({
    ...adapter,
    probe: frozenProbeContract(adapter.probe, declared),
  });
}

function withDeclaredImplementerProbe(adapter: CliImplementerAdapter): CliImplementerAdapter {
  const declared = declaredProbe(adapter);
  return Object.freeze({
    ...adapter,
    probe: frozenProbeContract(adapter.probe, declared),
  });
}

function assembleImplementerAdapters(): Record<ImplementerCliToolId, CliImplementerAdapter> {
  const adapters = {
    'claude-code': withDeclaredImplementerProbe(claudeCodeImplementerAdapter),
    codex: withDeclaredImplementerProbe(codexImplementerAdapter),
    opencode: withDeclaredImplementerProbe(opencodeImplementerAdapter),
    copilot: withDeclaredImplementerProbe(copilotImplementerAdapter),
    'kilo-code': withDeclaredImplementerProbe(kiloImplementerAdapter),
    cursor: withDeclaredImplementerProbe(cursorImplementerAdapter),
    'command-code': withDeclaredImplementerProbe(commandCodeImplementerAdapter),
    antigravity: withDeclaredImplementerProbe(antigravityImplementerAdapter),
  } satisfies Record<ImplementerCliToolId, CliImplementerAdapter>;

  return Object.freeze(adapters);
}

function assemblePlannerAdapters(): Record<PlannerCliToolId, CliPlannerAdapter> {
  return Object.freeze({
    'claude-code': withDeclaredPlannerProbe(claudeCodePlannerAdapter),
    codex: withDeclaredPlannerProbe(codexPlannerAdapter),
    opencode: withDeclaredPlannerProbe(opencodePlannerAdapter),
    copilot: withDeclaredPlannerProbe(copilotPlannerAdapter),
    'kilo-code': withDeclaredPlannerProbe(kiloPlannerAdapter),
    cursor: withDeclaredPlannerProbe(cursorPlannerAdapter),
    'command-code': withDeclaredPlannerProbe(commandCodePlannerAdapter),
    antigravity: withDeclaredPlannerProbe(antigravityPlannerAdapter),
  });
}

export const CLI_PLANNER_ADAPTERS = assemblePlannerAdapters();
export const CLI_IMPLEMENTER_ADAPTERS = assembleImplementerAdapters();

export function lookupCliPlannerAdapter(toolId: string): CliPlannerAdapter {
  if (!includes(PLANNER_CLI_TOOL_IDS, toolId)) {
    throw runnerConfigError.missingToolConfig(toolId, 'planner');
  }
  return CLI_PLANNER_ADAPTERS[toolId];
}

export function lookupCliImplementerAdapter(toolId: string): CliImplementerAdapter {
  if (!includes(IMPLEMENTER_CLI_TOOL_IDS, toolId)) {
    throw runnerConfigError.missingToolConfig(toolId, 'implementer');
  }
  return CLI_IMPLEMENTER_ADAPTERS[toolId];
}

/** The prompt limit a CLI tool declares for a seat role; undefined for a tool without one. */
export function cliPromptLimit(
  role: 'planner' | 'implementer',
  toolId: string,
): PromptLimit | undefined {
  if (role === 'implementer') {
    return includes(IMPLEMENTER_CLI_TOOL_IDS, toolId)
      ? CLI_IMPLEMENTER_ADAPTERS[toolId].promptLimit
      : undefined;
  }
  return includes(PLANNER_CLI_TOOL_IDS, toolId)
    ? CLI_PLANNER_ADAPTERS[toolId].promptLimit
    : undefined;
}

/** True when a CLI tool's review call reads workspace files of its own. */
export function cliReviewReadsFiles(toolId: string): boolean {
  return includes(PLANNER_CLI_TOOL_IDS, toolId)
    ? CLI_PLANNER_ADAPTERS[toolId].readsFiles === true
    : false;
}

/** Returns the admitted role-bound probe without exposing any probe output. */
export function lookupCliReadinessProbe(
  input: Readonly<{
    tool: CliToolId;
    role: RunnerRole;
  }>,
): CliProbeContract {
  return input.role === 'planner'
    ? lookupCliPlannerAdapter(input.tool).probe
    : lookupCliImplementerAdapter(input.tool).probe;
}

/**
 * Catalog admission is allowed only for the immutable declared probe instance
 * owned by the selected production adapter. This is intentionally identity
 * based: a structurally similar caller-supplied contract is not evidence.
 */
export function isCanonicalCliDeclaredProbe(
  input: Readonly<{
    tool: CliToolId;
    role?: RunnerRole | undefined;
    probe: CliDeclaredProbeContract;
  }>,
): boolean {
  const declared =
    input.role === 'planner'
      ? [CLI_PLANNER_ADAPTERS[input.tool].probe.declared]
      : input.role === 'implementer'
        ? [CLI_IMPLEMENTER_ADAPTERS[input.tool].probe.declared]
        : [
            CLI_PLANNER_ADAPTERS[input.tool].probe.declared,
            CLI_IMPLEMENTER_ADAPTERS[input.tool].probe.declared,
          ];
  return declared.some((candidate) => candidate === input.probe);
}
