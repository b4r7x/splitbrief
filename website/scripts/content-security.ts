import type { Root } from 'mdast';
import type { Node } from 'unist';
import { documentNodes } from './mdx-ast.js';

type SecurityIssue = {
  readonly line: number;
  readonly message: string;
};

const EXECUTABLE_NODE_LABELS = new Map([
  ['mdxjsEsm', 'ESM import/export'],
  ['mdxFlowExpression', 'flow expression'],
  ['mdxTextExpression', 'text expression'],
  ['mdxJsxFlowElement', 'flow JSX'],
  ['mdxJsxTextElement', 'inline JSX'],
  ['html', 'raw HTML'],
]);
const SAFE_URL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const CREDENTIAL_QUERY_KEYS = new Set([
  'access_token',
  'accesstoken',
  'api_key',
  'apikey',
  'auth_token',
  'authtoken',
  'client_secret',
  'clientsecret',
  'passwd',
  'password',
  'refresh_token',
  'refreshtoken',
  'x_api_key',
  'xapikey',
]);
const SECRET_PATTERNS = [
  {
    label: 'private key',
    pattern: /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/,
  },
  { label: 'AWS access key', pattern: /\bAKIA[A-Z0-9]{16}\b/ },
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { label: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'Google API key', pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/ },
  { label: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  { label: 'OpenAI-style key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { label: 'Stripe live key', pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/ },
  {
    label: 'Bearer token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*\b/i,
  },
  {
    label: 'credential assignment',
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?(?!\$\{?|process\.env|<|\.\.\.)[A-Za-z0-9_./+=-]{20,}/i,
  },
] as const;
const PLACEHOLDER_VALUE =
  /(?:\.\.\.|<[^>]+>|\$\{[^}]+\}|(?:YOUR|REPLACE(?:_WITH)?|EXAMPLE|PLACEHOLDER|REDACTED|CHANGE_ME)(?:[-_](?:API[-_]?)?(?:KEY|TOKEN|SECRET|VALUE|ME|HERE))?)/i;

type UrlNode = Node & {
  readonly url: string;
};

function hasUrl(node: Node): node is UrlNode {
  return (
    (node.type === 'definition' || node.type === 'image' || node.type === 'link') &&
    'url' in node &&
    typeof node.url === 'string'
  );
}

function isPlaceholder(value: string): boolean {
  return value.trim().length === 0 || PLACEHOLDER_VALUE.test(value);
}

function normalizedQueryKey(key: string): string {
  return key.toLowerCase().replaceAll('-', '_').replaceAll('.', '_');
}

function urlViolation(href: string): string | undefined {
  const value = href.trim();
  if (value.startsWith('//')) {
    return 'protocol-relative URL is not allowed';
  }

  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (scheme && !SAFE_URL_SCHEMES.has(scheme)) {
    return `unsafe URL scheme "${scheme}:" is not allowed`;
  }
  if (scheme !== 'http' && scheme !== 'https') {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'absolute HTTP URL is malformed';
  }
  if (url.username !== '' || url.password !== '') {
    return 'credentials in URL userinfo are not allowed';
  }
  for (const [key, credential] of url.searchParams) {
    if (CREDENTIAL_QUERY_KEYS.has(normalizedQueryKey(key)) && !isPlaceholder(credential)) {
      return `credential query parameter "${key}" is not allowed`;
    }
  }

  return undefined;
}

export function validateDocumentSecurity(options: {
  readonly bodyStartLine: number;
  readonly source: string;
  readonly tree: Root;
}): readonly SecurityIssue[] {
  const issues: SecurityIssue[] = [];

  for (const node of documentNodes(options.tree)) {
    const executableLabel = EXECUTABLE_NODE_LABELS.get(node.type);
    if (executableLabel) {
      issues.push({
        line: (node.position?.start.line ?? 1) + options.bodyStartLine - 1,
        message: `${executableLabel} is not allowed in documentation MDX`,
      });
    }

    if (hasUrl(node)) {
      const message = urlViolation(node.url);
      if (message) {
        issues.push({
          line: (node.position?.start.line ?? 1) + options.bodyStartLine - 1,
          message,
        });
      }
    }
  }

  const lines = options.source.split('\n');
  for (const secretPattern of SECRET_PATTERNS) {
    const match = lines
      .map((line, lineIndex) => ({ lineIndex, value: secretPattern.pattern.exec(line)?.[0] }))
      .find((candidate) => candidate.value && !isPlaceholder(candidate.value));
    if (match) {
      issues.push({
        line: match.lineIndex + 1,
        message: `possible secret matches ${secretPattern.label}`,
      });
    }
  }

  return issues;
}
