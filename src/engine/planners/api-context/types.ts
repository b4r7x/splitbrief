import type { ProjectContext } from '../context.js';
import type { PriorMessage } from '../types.js';

type ApiContextEntryKind = 'required' | 'optional';
export type ApiContextEntryState = 'included' | 'excerpt' | 'omitted' | 'missing' | 'unsupported';

/** One line of the packet's manifest: what was supplied, and in what shape. */
export type ApiContextManifestEntry = Readonly<{
  path: string;
  kind: ApiContextEntryKind;
  state: ApiContextEntryState;
  startLine?: number;
  endLine?: number;
  sha256?: string;
}>;

/** One prior planning document handed to this call. */
export type ApiPlanningArtifact = Readonly<{
  /** Logical name, as the manifest and a refusal spell it (`spec.md`). */
  name: string;
  text: string;
  /** The step declares it, so an empty one is missing evidence, not absence. */
  required: boolean;
}>;

export type ApiPlanningContextInput = Readonly<{
  projectDir: string;
  /** Canonical instructions and project metadata, with what they left out. */
  project: ProjectContext;
  /** The feature request this run is planning. */
  request: string;
  artifacts?: readonly ApiPlanningArtifact[] | undefined;
  /** Exact declared targets of the current briefs. */
  taskFiles?: readonly string[] | undefined;
  /** What the operator said for this call, and the rejections it must respect. */
  steer?: string | undefined;
  priorMessages?: readonly PriorMessage[] | undefined;
  /** The ranked repo map, highest rank first, as the run already built it. */
  repoMap?: string | undefined;
  /** True when this call's prompt carries the map, so the budget counts it. */
  repoMapInPrompt?: boolean | undefined;
  skills?: string | undefined;
  /** Input-token window that optional source packs into, after the required material. */
  availableTokens: number;
  /**
   * The input allocation of a Prompt budget the user set. Only then does required material
   * that does not fit refuse the packet; with none, it goes whole and the provider answers.
   */
  userBudgetTokens?: number | undefined;
  /** Selected model, for the estimate's character ratio. */
  model?: string | undefined;
  /** Measures the complete wire prompt, including framing and estimate margin. */
  measureInput?: ((packet: string) => number) | undefined;
}>;

export type ApiPlanningContext =
  | Readonly<{
      kind: 'complete';
      text: string;
      manifest: readonly ApiContextManifestEntry[];
    }>
  | Readonly<{
      kind: 'insufficient-context';
      cause: 'missing-required' | 'unsupported-required' | 'input-budget';
      missingSections: readonly string[];
      requiredTokens: number;
      availableTokens: number;
      manifest: readonly ApiContextManifestEntry[];
    }>;
