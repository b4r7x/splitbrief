import type {
  CliExecutableIdentity,
  CliExecutableReceipt,
} from '../../../core/discovery/detection/executable.js';
import type * as Detection from '../../../core/discovery/detection/executable.js';

export type CliExecutableTrust = Detection.CliExecutableTrust | null | undefined;

export type CliExecutableResolver = (
  options: Readonly<{ command: string; projectDir: string; trust?: CliExecutableTrust }>,
) => Promise<CliExecutableIdentity>;

export type ResolvedCliExecutable = Readonly<{
  /** The catalog candidate whose exact identity was selected. */
  command: string;
  executable: CliExecutableIdentity;
  /** `true` only when every earlier catalog candidate was absent. */
  usedFallback: boolean;
}>;

export type ResolveCliExecutableAliasesOptions = Readonly<{
  commands: readonly string[];
  projectDir: string;
  trust?: CliExecutableTrust;
  resolveExecutable?: CliExecutableResolver;
}>;

export type CustomExecutableResolution =
  | Readonly<{ kind: 'resolved'; executable: CliExecutableReceipt }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'non-executable' }>
  | Readonly<{ kind: 'identity-drifted'; executable: CliExecutableReceipt }>
  | Readonly<{ kind: 'invalid' }>;

export type ResolveCustomExecutableOptions = Readonly<{
  command: string;
  projectDir: string;
  expected?: CliExecutableReceipt | undefined;
  pathEnv?: string | undefined;
  pathExt?: string | undefined;
}>;

export type DiagnosticIdentity = Readonly<{
  fingerprint: CliExecutableIdentity['fingerprint'];
}>;
