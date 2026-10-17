export const STACK_IDS = ['typescript', 'javascript', 'python', 'go', 'rust'] as const;
export type StackId = (typeof STACK_IDS)[number];

export const NARROWING_KINDS = ['path-arg', 'package-arg', 'cargo-target', 'none'] as const;

export type TestNarrowing = Extract<
  | { kind: 'path-arg'; separator: '--' | '' }
  | { kind: 'package-arg' }
  | { kind: 'cargo-target' }
  | { kind: 'none' },
  { kind: (typeof NARROWING_KINDS)[number] }
>;

export type StackMarker = string | ((projectDir: string) => boolean);

export type Stack = Readonly<{
  id: StackId;
  // The LanguageContext key: `buildLanguageContext(stack.language)`.
  language: string;
  // Project-relative files; the first marker that exists admits the row.
  markers: readonly StackMarker[];
  test: (projectDir: string) => string | null;
  // Single-`*` globs, one per convention.
  testFilePatterns: readonly string[];
  // Mirrors of `src`, e.g. ['tests', 'test', '__tests__'].
  testDirs: readonly string[];
  inlineTests?: RegExp | undefined;
  narrowing: TestNarrowing;
  // Feeds the planner-discovery allowlist.
  allowedCommands: readonly string[];
}>;
