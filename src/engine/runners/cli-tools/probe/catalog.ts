import type { DetectedModel } from '../../../../core/discovery/detection/model.js';
import type { CliToolId } from '../../../../core/runners/cli-tool/types.js';
import { CODEX_NATIVE_MODEL_CATALOG_PROBE } from '../codex/adapter.js';
import type { CliProbeParser, CliCatalogProbe } from './contract.js';
import { parseCodexNativeModelCatalog } from './native-catalog/codex.js';
import { parseCommandCodeNativeModelCatalog } from './native-catalog/command-code.js';
import {
  type NativeCliModelCatalog,
  nativeCliCatalogToDetectedModels,
} from './native-catalog/entries.js';
import {
  parseCursorNativeModelCatalog,
  parseCopilotHelpConfigCatalog,
  parseAntigravityModelCatalog,
} from './native-catalog/listing.js';
import {
  parseOpenCodeNativeModelCatalog,
  parseOpenCodeVerboseModelCatalog,
  parseKiloNativeModelCatalog,
} from './native-catalog/opencode.js';
import { ownedProbeCommand } from './safety.js';

type NativeCatalogParser = (
  stdout: string,
  homeFiles?: readonly string[],
) => NativeCliModelCatalog | null;

function catalogParse(parser: NativeCatalogParser): CliProbeParser<readonly DetectedModel[]> {
  return (output) => {
    const catalog = parser(output.stdout, output.homeFiles);
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
    directoryHeader?: 'x-opencode-directory' | undefined;
    homeFilesDirectory?: readonly string[] | undefined;
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
    maxOutputBytes: CODEX_NATIVE_MODEL_CATALOG_PROBE.maxOutputBytes,
    ...(manualCommand === undefined ? {} : { manualCommand }),
    ...(input.directoryHeader === undefined ? {} : { directoryHeader: input.directoryHeader }),
    ...(input.homeFilesDirectory === undefined
      ? {}
      : { homeFilesDirectory: Object.freeze([...input.homeFilesDirectory]) }),
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

export function declaredCatalogProbe(tool: CliToolId): CliCatalogProbe {
  switch (tool) {
    case 'codex':
      return structuralCatalogProbe({
        command: CODEX_NATIVE_MODEL_CATALOG_PROBE.command,
        parser: parseCodexNativeModelCatalog,
      });
    case 'opencode':
      return structuralCatalogProbe({
        // The listing starts a standalone server in the channel's own staging, so it
        // lists only the providers a run can reach.
        command: ['opencode', 'api', 'GET', '/api/model', '--standalone'],
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
      });
    case 'cursor':
      return structuralCatalogProbe({
        command: ['cursor-agent', '--list-models'],
        parser: parseCursorNativeModelCatalog,
      });
    case 'command-code':
      return structuralCatalogProbe({
        command: ['cmd', '--list-models', '--no-auto-update'],
        // cmd 1.88.5 writes each model's levels, label, input and window to this cache
        // while the listing runs; the listing itself prints ids and blurbs only.
        homeFilesDirectory: ['.commandcode', 'cache', 'model-catalog', 'v1'],
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
      });
    case 'claude-code':
      return { kind: 'not-run' };
  }
}
