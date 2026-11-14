import type { DetectedModel } from '../../../../core/discovery/detection/model.js';
import type { ProbeOutcome, AuthFact } from '../../../../core/discovery/runner-evidence.js';

export type CliProbeCommand = Readonly<{
  command: readonly [string, ...string[]];
  cwd: 'neutral';
  maxOutputBytes: number;
}>;

export type CliProbeOutput = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputExceeded: boolean;
  /** The text of the files a catalog probe's `homeFilesDirectory` holds after the listing. */
  homeFiles?: readonly string[] | undefined;
}>;

export type CliProbeParser<Value> = (input: CliProbeOutput) => ProbeOutcome<Value>;

export type CliVersionProbe = CliProbeCommand &
  Readonly<{
    kind: 'version';
    parse: CliProbeParser<string>;
  }>;

/** The argv releases below `belowVersion` take instead of the declared one; `parse` reads both listings. */
export type CliAuthProbeLegacy = Readonly<{
  belowVersion: string;
  command: readonly [string, ...string[]];
}>;

export type CliAuthProbe =
  | Readonly<{ kind: 'not-run' }>
  | (CliProbeCommand &
      Readonly<{
        kind: 'auth-status';
        parse: (input: CliProbeOutput) => AuthFact;
        legacy?: CliAuthProbeLegacy | undefined;
      }>);

/**
 * The listing releases below `belowVersion` take instead of the declared one.
 * Unlike the auth legacy it carries its own `parse`, because the two releases
 * print different formats, and it inherits no `directoryHeader`: a legacy
 * listing the sandbox could already serve must not widen its posture.
 */
export type CliCatalogProbeLegacy = Readonly<{
  belowVersion: string;
  command: readonly [string, ...string[]];
  manualCommand?: readonly [string, ...string[]] | undefined;
  parse: CliProbeParser<readonly DetectedModel[]>;
}>;

export type CliCatalogProbe =
  | Readonly<{ kind: 'not-run' }>
  | (CliProbeCommand &
      Readonly<{
        kind: 'catalog';
        /** A separately declared fixed manual command; never caller-mutated argv. */
        manualCommand?: readonly [string, ...string[]] | undefined;
        /**
         * The request header that names the project directory to the tool's own
         * service, so the listing carries the providers the project's config sets up.
         * The service loads that config, its plugins and its MCP servers to answer,
         * so the probe sends it only for a tool the crew uses.
         */
        directoryHeader?: 'x-opencode-directory' | undefined;
        /**
         * A folder under the probe's staged HOME whose `.json` files the listing writes
         * as it runs. The probe reads them, up to `maxOutputBytes` each, before it
         * deletes the staging, and hands their text to `parse` as `homeFiles`.
         */
        homeFilesDirectory?: readonly string[] | undefined;
        legacy?: CliCatalogProbeLegacy | undefined;
        parse: CliProbeParser<readonly DetectedModel[]>;
      }>);

export type CliDeclaredProbeContract = Readonly<{
  kind: 'declared';
  version: CliVersionProbe;
  auth: CliAuthProbe;
  catalog: CliCatalogProbe;
}>;

/**
 * The legacy version command remains while detection migrates to
 * adapter-declared parser contracts. It carries no parser, so it cannot
 * establish authentication.
 */
export type CliProbeContract = Readonly<{
  version: CliProbeCommand;
  declared?: CliDeclaredProbeContract | undefined;
}>;

export function isDeclaredCliProbeContract(
  probe: CliProbeContract,
): probe is CliProbeContract & Readonly<{ declared: CliDeclaredProbeContract }> {
  return probe.declared !== undefined && probe.declared.kind === 'declared';
}
