import type { LanguageContext } from './language-context.js';
import { isJavaScriptLikeLanguage } from './language-context.js';

type EscalationExample = {
  label: string;
  error: string;
  rootCause: string;
  fix: string;
};

const TS_EXAMPLES: EscalationExample[] = [
  {
    label: 'Missing .js extension (ESM)',
    error: "Cannot find module './utils' imported from src/engine/foo.ts",
    rootCause: 'ESM TypeScript requires explicit .js file extensions on relative imports.',
    fix: "Change `import { fn } from './utils'` to `import { fn } from './utils.js'`.",
  },
  {
    label: 'Non-nullable type mismatch',
    error: "Argument of type 'string | undefined' is not assignable to parameter of type 'string'.",
    rootCause: 'Function parameter expects non-nullable string but received an optional value.',
    fix: 'Add a nullish check before passing: `if (val !== undefined) fn(val)` or use `fn(val ?? fallback)`.',
  },
  {
    label: 'Missing export',
    error: "Module '\"./config.js\"' has no exported member 'loadConfig'.",
    rootCause: 'The function exists but is not exported, or was renamed.',
    fix: 'Add `export` to the function declaration, or update the import to use the current name.',
  },
  {
    label: 'Test assertion mismatch',
    error: "expected 'idle' to equal 'implementing'",
    rootCause: 'State transition did not fire. The action was either not dispatched or the reducer does not handle it from the current phase.',
    fix: 'Check the transition table in machine.ts — verify the action is allowed from the current phase.',
  },
  {
    label: 'Async function not awaited',
    error: "Type 'Promise<void>' is not assignable to type 'void'.",
    rootCause: 'An async function is called without await, so the return type is Promise instead of the resolved value.',
    fix: 'Add `await` at the call site, or mark the calling function as `async`.',
  },
];

const PYTHON_EXAMPLES: EscalationExample[] = [
  {
    label: 'Import path error',
    error: "ModuleNotFoundError: No module named 'utils.helpers'",
    rootCause: 'Python cannot resolve the module path — missing __init__.py or wrong package structure.',
    fix: 'Add __init__.py to the package directory, or use relative import: `from .helpers import fn`.',
  },
  {
    label: 'Type annotation error',
    error: 'TypeError: expected str, got Optional[str]',
    rootCause: 'Function receives Optional[str] but parameter type hint says str.',
    fix: 'Update type hint to `Optional[str]` and handle None case inside the function.',
  },
];

const GO_EXAMPLES: EscalationExample[] = [
  {
    label: 'Unused import',
    error: '"fmt" imported and not used',
    rootCause: 'Go does not allow unused imports — the import was added but not consumed.',
    fix: 'Remove the unused import, or use it. Go will not compile with dead imports.',
  },
];

const RUST_EXAMPLES: EscalationExample[] = [
  {
    label: 'Borrow checker violation',
    error: 'cannot borrow `x` as mutable because it is also borrowed as immutable',
    rootCause: 'An immutable borrow is still alive when a mutable borrow is attempted.',
    fix: 'Limit the scope of the immutable borrow, or clone the value before mutating.',
  },
];

const GENERIC_EXAMPLES: EscalationExample[] = [
  {
    label: 'Syntax error',
    error: 'SyntaxError: Unexpected token',
    rootCause: 'A structural syntax error — often a missing bracket, comma, or semicolon.',
    fix: 'Check the line referenced in the error and the line above it for unclosed brackets or missing punctuation.',
  },
];

function examplesForLanguage(ctx: LanguageContext): EscalationExample[] {
  if (isJavaScriptLikeLanguage(ctx)) return TS_EXAMPLES;
  switch (ctx.language) {
    case 'Python': return PYTHON_EXAMPLES;
    case 'Go': return GO_EXAMPLES;
    case 'Rust': return RUST_EXAMPLES;
    default: return GENERIC_EXAMPLES;
  }
}

export function selectRelevantExamples(
  error: string,
  ctx: LanguageContext,
  maxExamples = 2,
): EscalationExample[] {
  const pool = examplesForLanguage(ctx);
  const lower = error.toLowerCase();

  const scored = pool.map(ex => {
    const keywords = ex.error.toLowerCase().split(/\s+/);
    const hits = keywords.filter(kw => kw.length > 4 && lower.includes(kw)).length;
    return { example: ex, score: hits };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected = scored.slice(0, maxExamples).filter(s => s.score > 0);
  if (selected.length === 0) return [];
  return selected.map(s => s.example);
}

export function formatExamplesSection(examples: EscalationExample[]): string {
  return examples
    .map((ex, i) => `**Example ${i + 1}: ${ex.label}**
Error: \`${ex.error}\`
Root cause: ${ex.rootCause}
Fix: ${ex.fix}`)
    .join('\n\n');
}
