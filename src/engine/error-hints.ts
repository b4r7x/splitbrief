import { glyph } from '../lib/glyphs.js';

interface ErrorHint {
  message: string;
  hint: string;
}

const ERROR_PATTERNS: Array<[RegExp | ((msg: string) => boolean), ErrorHint]> = [
  [
    (msg) => /ECONNREFUSED/.test(msg) && /:11434\b/.test(msg),
    { message: 'Ollama is not running', hint: 'Start it with: ollama serve' },
  ],
  [
    (msg) => /ECONNREFUSED/.test(msg) && /:1234\b/.test(msg),
    { message: 'LM Studio is not running', hint: 'Start it from the application.' },
  ],
  [
    /model.*not.found|model_not_found|does not exist|couldn't find model/i,
    { message: 'Model not available', hint: 'Run `ollama pull MODEL` or check your provider.' },
  ],
  [
    /context.length.exceeded|context_length_exceeded/i,
    { message: 'Input too long for model', hint: 'Try a model with a larger context window.' },
  ],
  [
    /\b401\b|[Uu]nauthorized/,
    { message: 'Invalid API key', hint: 'Check your PROVIDER_API_KEY environment variable.' },
  ],
  [
    /access token could not be refreshed|log out and sign in again/i,
    {
      message: 'Runner session signed out or expired',
      hint: 'The provider reports this session/key as signed out or expired — check the credential for this runner',
    },
  ],
  [
    /please run \/login|oauth token has expired|oauth token revoked/i,
    {
      message: 'Runner session signed out or expired',
      hint: 'The provider reports this session/key as signed out or expired — check the credential for this runner',
    },
  ],
  [
    /\b429\b|[Tt]oo [Mm]any [Rr]equests|rate[._\s-]limit/i,
    {
      message: 'Rate limited by provider',
      hint: 'Wait for the limit to reset or switch runner profiles, then retry.',
    },
  ],
  [/ENOTFOUND/, { message: 'Cannot reach host', hint: 'Check your network connection.' }],
  [/ECONNREFUSED/, { message: 'Cannot connect to provider', hint: 'Is the service running?' }],
];

export function getErrorHint(error: string): ErrorHint | undefined {
  for (const [matcher, hint] of ERROR_PATTERNS) {
    if (typeof matcher === 'function' ? matcher(error) : matcher.test(error)) {
      return hint;
    }
  }
  return undefined;
}

export function formatErrorWithHint(error: string): string {
  const hint = getErrorHint(error);
  if (!hint) return error;
  return `${hint.message}\n  ${glyph('connectorHandoff')} ${hint.hint}`;
}
