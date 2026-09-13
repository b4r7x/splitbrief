type ScopeEntryCase = {
  readonly name: string;
  readonly entry: string;
  readonly matches: readonly string[];
  readonly nonMatches: readonly string[];
};

export const SCOPE_ENTRY_CASES: readonly ScopeEntryCase[] = [
  {
    name: 'prose bullet around a backticked path',
    entry: '`src/x.ts` — the union collapse',
    matches: ['src/x.ts'],
    nonMatches: ['src/y.ts'],
  },
  {
    name: 'backtick bullet',
    entry: '`src/api/handler.ts`',
    matches: ['src/api/handler.ts'],
    nonMatches: ['src/api/other.ts'],
  },
  {
    name: 'glob',
    entry: 'src/api/**',
    matches: ['src/api/routes.ts', 'src/api/v1/routes.ts'],
    nonMatches: ['src/app.ts'],
  },
  {
    name: 'bare filename',
    entry: 'tsconfig.json',
    matches: ['tsconfig.json'],
    nonMatches: ['tsconfig.base.json'],
  },
  {
    name: 'dot-slash prefixed path',
    entry: './src/x.ts',
    matches: ['src/x.ts', './src/x.ts'],
    nonMatches: ['src/x.test.ts'],
  },
  {
    name: 'prose with no path token',
    entry: 'the auth flow and nothing else',
    matches: [],
    nonMatches: ['src/x.ts'],
  },
];
