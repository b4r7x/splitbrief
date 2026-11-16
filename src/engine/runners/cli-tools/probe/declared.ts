import type {
  CliVersionProbe,
  CliAuthProbe,
  CliCatalogProbe,
  CliDeclaredProbeContract,
} from './contract.js';
import { ownedProbeCommand } from './safety.js';

function frozenParser<Parser extends object>(parser: Parser): Parser {
  return Object.freeze(parser);
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

export function frozenDeclaredProbe(probe: CliDeclaredProbeContract): CliDeclaredProbeContract {
  return Object.freeze({
    version: frozenVersionProbe(probe.version),
    auth: frozenAuthProbe(probe.auth),
    catalog: frozenCatalogProbe(probe.catalog),
  });
}
