type ShikiTheme = {
  name: string;
  type: 'dark' | 'light';
  colors: {
    'editor.background': string;
    'editor.foreground': string;
  };
  settings: Array<{
    scope?: string[];
    settings: {
      background?: string;
      fontStyle?: string;
      foreground?: string;
    };
  }>;
};

const COMMENT_SCOPES = ['comment', 'punctuation.definition.comment'];

const PLANNER_SCOPES = [
  'keyword',
  'storage.type',
  'storage.modifier',
  'entity.name.tag.yaml',
  'support.type.property-name',
  'entity.other.attribute-name',
  'meta.object-literal.key',
  'markup.heading',
];

const IMPLEMENTER_SCOPES = [
  'string',
  'string.unquoted.plain.out.yaml',
  'constant',
  'support.constant',
  'entity.name.function',
  'support.function',
  'markup.inline.raw',
  'markup.underline.link',
];

export const splitbriefDark = {
  name: 'splitbrief-dark',
  type: 'dark',
  colors: {
    'editor.background': '#141416',
    'editor.foreground': '#E8E6E1',
  },
  settings: [
    {
      settings: {
        background: '#141416',
        foreground: '#E8E6E1',
      },
    },
    {
      scope: COMMENT_SCOPES,
      settings: {
        fontStyle: 'italic',
        foreground: '#A8A6A1',
      },
    },
    {
      scope: PLANNER_SCOPES,
      settings: {
        foreground: '#E85FA8',
      },
    },
    {
      scope: IMPLEMENTER_SCOPES,
      settings: {
        foreground: '#3FD2E0',
      },
    },
  ],
} satisfies ShikiTheme;

export const splitbriefDocsLight = {
  name: 'splitbrief-docs-light',
  type: 'light',
  colors: {
    'editor.background': '#DDDBD6',
    'editor.foreground': '#1A1A1C',
  },
  settings: [
    {
      settings: {
        background: '#DDDBD6',
        foreground: '#1A1A1C',
      },
    },
    {
      scope: COMMENT_SCOPES,
      settings: {
        fontStyle: 'italic',
        foreground: '#55554F',
      },
    },
    {
      scope: PLANNER_SCOPES,
      settings: {
        foreground: '#A01A67',
      },
    },
    {
      scope: IMPLEMENTER_SCOPES,
      settings: {
        foreground: '#0B5E66',
      },
    },
  ],
} satisfies ShikiTheme;
