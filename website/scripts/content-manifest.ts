export type ContentMode = 'as-is' | 'new' | 'rewrite';

type ContentPageDefinition = {
  readonly mode: ContentMode;
  readonly slug: string;
  readonly title: string;
};

type ContentGroupDefinition = {
  readonly pages: readonly ContentPageDefinition[];
  readonly path: string;
  readonly title: string;
};

const CONTENT_MANIFEST = [
  {
    path: 'getting-started',
    title: 'Getting started',
    pages: [
      { slug: 'introduction', title: 'Introduction', mode: 'rewrite' },
      { slug: 'installation', title: 'Installation', mode: 'new' },
      { slug: 'quickstart', title: 'Quickstart', mode: 'rewrite' },
      { slug: 'choosing-models', title: 'Choosing models', mode: 'new' },
    ],
  },
  {
    path: 'concepts',
    title: 'Concepts',
    pages: [
      { slug: 'the-two-role-model', title: 'The two-role model', mode: 'rewrite' },
      { slug: 'task-briefs', title: 'Task Briefs', mode: 'rewrite' },
      { slug: 'workflow-modes-and-phases', title: 'Workflow modes & phases', mode: 'rewrite' },
      {
        slug: 'approval-escalation-and-recovery',
        title: 'Approval, escalation & recovery',
        mode: 'rewrite',
      },
      { slug: 'sessions-and-persistence', title: 'Sessions & persistence', mode: 'rewrite' },
      { slug: 'glossary', title: 'Glossary', mode: 'rewrite' },
    ],
  },
  {
    path: 'guides',
    title: 'Guides',
    pages: [
      { slug: 'cookbook', title: 'Cookbook', mode: 'as-is' },
      {
        slug: 'planners-and-implementers',
        title: 'Planners & implementers',
        mode: 'rewrite',
      },
      {
        slug: 'cost-management-and-budgets',
        title: 'Cost management & budgets',
        mode: 'rewrite',
      },
      {
        slug: 'safety-snapshots-drift-approval',
        title: 'Safety: snapshots, drift, approval',
        mode: 'rewrite',
      },
      { slug: 'hooks', title: 'Hooks', mode: 'as-is' },
      {
        slug: 'worktrees-and-parallel-sessions',
        title: 'Worktrees & parallel sessions',
        mode: 'as-is',
      },
      { slug: 'headless-and-ci', title: 'Headless & CI', mode: 'rewrite' },
      { slug: 'mcp-and-handoff-packs', title: 'MCP & handoff packs', mode: 'rewrite' },
      { slug: 'repo-map', title: 'Repo-map', mode: 'as-is' },
      { slug: 'observability-otel', title: 'Observability (OTel)', mode: 'as-is' },
      { slug: 'api-key-security', title: 'API key security', mode: 'as-is' },
      { slug: 'debugging-a-run', title: 'Debugging a run', mode: 'as-is' },
    ],
  },
  {
    path: 'reference',
    title: 'Reference',
    pages: [
      { slug: 'cli', title: 'CLI', mode: 'as-is' },
      { slug: 'slash-commands-and-keys', title: 'Slash commands & keys', mode: 'as-is' },
      { slug: 'configuration', title: 'Configuration', mode: 'as-is' },
      { slug: 'task-brief-format', title: 'Task Brief format', mode: 'as-is' },
      { slug: 'troubleshooting', title: 'Troubleshooting', mode: 'as-is' },
      { slug: 'migration', title: 'Migration', mode: 'as-is' },
      { slug: 'changelog', title: 'Changelog', mode: 'as-is' },
    ],
  },
  {
    path: 'project',
    title: 'Project',
    pages: [
      {
        slug: 'why-splitbrief-comparison',
        title: 'Why SPLITBRIEF / comparison',
        mode: 'rewrite',
      },
      { slug: 'roadmap', title: 'Roadmap', mode: 'rewrite' },
      { slug: 'faq', title: 'FAQ', mode: 'new' },
    ],
  },
] as const satisfies readonly ContentGroupDefinition[];

type ContentPage = {
  readonly mode: ContentMode;
  readonly path: string;
};

type ContentPageContract = ContentPage & {
  readonly title: string;
};

type ContentGroup = {
  readonly pages: readonly string[];
  readonly path: string;
  readonly title: string;
};

export const CONTENT_GROUPS: readonly ContentGroup[] = CONTENT_MANIFEST.map((group) => ({
  path: group.path,
  title: group.title,
  pages: group.pages.map((page) => page.slug),
}));

export const CONTENT_PAGE_CONTRACTS: readonly ContentPageContract[] = CONTENT_MANIFEST.flatMap(
  (group) =>
    group.pages.map((page) => ({
      path: `${group.path}/${page.slug}`,
      title: page.title,
      mode: page.mode,
    })),
);

export const CONTENT_PAGES: readonly ContentPage[] = CONTENT_PAGE_CONTRACTS.map((page) => ({
  path: page.path,
  mode: page.mode,
}));

export const ROOT_META_PAGES = CONTENT_GROUPS.flatMap((group) => [
  `---${group.title}---`,
  `...${group.path}`,
]);
