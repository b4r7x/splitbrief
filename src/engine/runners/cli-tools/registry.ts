import { assertCandidateFilesAbsent } from '../../../core/runners/candidate-admission.js';
import { cliAdmissionError } from '../../../core/runners/cli-admission-error.js';
import {
  nativeCliCatalogToDetectedModels,
  parseCodexNativeModelCatalog,
  parseCommandCodeNativeModelCatalog,
  parseCursorNativeModelCatalog,
  parseKiloNativeModelCatalog,
  parseOpenCodeNativeModelCatalog,
  type NativeCliModelCatalog,
} from '../../providers/cli-model-catalog.js';
import {
  ANTIGRAVITY_CLI_CANDIDATE_PATHS,
  CLI_COMPILER_EVIDENCE,
  CLI_TOOL_CATALOG,
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
  type CliCompilerEvidence,
  type CliToolId,
} from '../../../core/runners/cli-tool-catalog.js';
import type { RunnerRole } from '../../../core/runners/seat-roles.js';
import type { PlannerCliToolId, ImplementerCliToolId } from '../../../core/schemas/enums.js';
import { includes, isRecord } from '../../../utils/type-guards.js';
import { runnerConfigError } from '../errors.js';
import { refusedCompilerAdmission, type RefusedCompilerAdmission } from '../compiler-capability.js';
import type { CompilerRuntimeEvidence } from '../compiler-runtime-evidence.js';
import { claudeCodeImplementerAdapter, claudeCodePlannerAdapter } from './claude-code.js';
import { codexImplementerAdapter, codexPlannerAdapter } from './codex.js';
import { CODEX_NATIVE_MODEL_CATALOG_PROBE } from './codex.js';
import { commandCodeImplementerAdapter, commandCodePlannerAdapter } from './command-code.js';
import { copilotImplementerAdapter, copilotPlannerAdapter } from './copilot.js';
import { cursorImplementerAdapter, cursorPlannerAdapter } from './cursor.js';
import { kiloImplementerAdapter, kiloPlannerAdapter } from './kilo-code.js';
import { opencodeImplementerAdapter, opencodePlannerAdapter } from './opencode.js';
import { providerOracleAuthFact, providerOracleCommand } from './provider-oracle.js';
import type {
  CliAuthProbe,
  CliCatalogProbe,
  CliDeclaredProbeContract,
  CliImplementerAdapter,
  CliPlannerAdapter,
  CliProbeCommand,
  CliProbeContract,
  CliProbeOutput,
  CliVersionProbe,
} from './contract.js';

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_MAX_BYTES = 4_096;
const PROVIDER_ORACLE_TIMEOUT_MS = 10_000;
const PROVIDER_ORACLE_OUTPUT_MAX_BYTES = 16_384;
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
    // These CLIs deliberately expose a bare version as their documented
    // version contract. The whole line must be the one semver token.
    case 'opencode':
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
  const matchers =
    format.kind === 'bare'
      ? [new RegExp(`^v?(${SEMVER_PATTERN})$`, 'i')]
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
  if (
    text.includes('offline') ||
    text.includes('network') ||
    text.includes('connection refused') ||
    text.includes('dns')
  ) {
    return 'offline' as const;
  }
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
      return {
        kind: 'auth-status',
        command: oracle,
        cwd: 'neutral',
        timeoutMs: PROVIDER_ORACLE_TIMEOUT_MS,
        maxOutputBytes: PROVIDER_ORACLE_OUTPUT_MAX_BYTES,
        parse: providerOracleAuthFact,
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
    case 'command-code':
      return {
        kind: 'auth-status',
        command: [command, 'status', '--json'],
        cwd: 'neutral',
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: PROBE_OUTPUT_MAX_BYTES,
        parse: parseCommandCodeStatusAuth,
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

function structuralCatalogProbe(
  input: Readonly<{
    command: readonly [string, ...string[]];
    parser: NativeCatalogParser;
    manualCommand?: readonly [string, ...string[]] | undefined;
  }>,
): Exclude<CliCatalogProbe, { kind: 'not-run' }> {
  const command = ownedProbeCommand(input.command);
  const manualCommand =
    input.manualCommand === undefined ? undefined : ownedProbeCommand(input.manualCommand);
  const parser = input.parser;
  return {
    kind: 'catalog',
    command,
    cwd: 'neutral',
    timeoutMs: CODEX_NATIVE_MODEL_CATALOG_PROBE.timeoutMs,
    maxOutputBytes: CODEX_NATIVE_MODEL_CATALOG_PROBE.maxOutputBytes,
    ...(manualCommand === undefined ? {} : { manualCommand }),
    parse: (output) => {
      const catalog = parser(output.stdout);
      return catalog === null
        ? { kind: 'malformed' }
        : { kind: 'success', value: nativeCliCatalogToDetectedModels(catalog) };
    },
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
        command: ['opencode', 'models', '--verbose'],
        manualCommand: ['opencode', 'models', '--verbose', '--refresh'],
        parser: parseOpenCodeNativeModelCatalog,
      });
    case 'kilo-code':
      return structuralCatalogProbe({
        command: ['kilo', 'models', '--verbose'],
        manualCommand: ['kilo', 'models', '--verbose', '--refresh'],
        parser: parseKiloNativeModelCatalog,
      });
    case 'cursor':
      return structuralCatalogProbe({
        command: ['cursor-agent', '--list-models'],
        parser: parseCursorNativeModelCatalog,
      });
    case 'command-code':
      return structuralCatalogProbe({
        command: ['cmd', '--list-models'],
        parser: parseCommandCodeNativeModelCatalog,
      });
    case 'claude-code':
    case 'copilot':
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
  } satisfies Record<ImplementerCliToolId, CliImplementerAdapter>;

  assertCandidateFilesAbsent(
    ANTIGRAVITY_CLI_CANDIDATE_PATHS,
    cliAdmissionError.omitRequiresAbsentSource,
  );

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

export type CliCompilerRuntimeAdmission =
  | Readonly<{ kind: 'admitted'; evidence: CliCompilerEvidence }>
  | RefusedCompilerAdmission;

/**
 * Registry-side compiler admission (REQ-003, REQ-016, REQ-049): a gate, not a
 * source of evidence — the seam consumes the admitted/refused decision and
 * keeps using the bound runtime evidence. Evidence with a drifted version
 * observation is admitted for supported tools. Runtime evidence bound for this
 * same tool carries the catalog's identity fields by construction —
 * `bindCompilerRuntimeEvidence` copies them out of the support table row this
 * record owns — so the comparisons below exist to enumerate the mismatched
 * properties when a caller binds one tool's runtime and admits it under
 * another, and the loader-only refusal to fail closed for a caller that reaches
 * here without that bind.
 */
export function admitCliCompilerRuntime(
  input: Readonly<{ tool: CliToolId; runtime: CompilerRuntimeEvidence }>,
): CliCompilerRuntimeAdmission {
  const evidence = CLI_COMPILER_EVIDENCE[input.tool];
  if (evidence.state === 'unsupported') {
    return refusedCompilerAdmission({
      stage: 'runtime',
      backend: input.tool,
      claimedVersion: input.runtime.version,
      missing: ['backend'],
      ...(evidence.unsupportedReason === undefined ? {} : { detail: evidence.unsupportedReason }),
    });
  }
  const missing: string[] = [];
  if (input.runtime.backend !== input.tool) missing.push('backend');
  if (input.runtime.version !== evidence.version) missing.push('version');
  if (input.runtime.terminalContract !== evidence.terminalContract)
    missing.push('terminalContract');
  if (input.runtime.fixtureDate !== evidence.fixtureDate) missing.push('fixtureDate');
  if (
    input.runtime.transports.length !== evidence.transports.length ||
    !input.runtime.transports.every((transport) => evidence.transports.includes(transport))
  ) {
    missing.push('transport');
  }
  if (missing.length > 0) {
    return refusedCompilerAdmission({
      stage: 'runtime',
      backend: input.tool,
      claimedVersion: input.runtime.version,
      missing,
    });
  }
  return { kind: 'admitted', evidence };
}
