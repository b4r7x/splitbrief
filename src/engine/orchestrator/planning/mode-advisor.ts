import type { WorkflowMode } from '../../../core/schemas/enums.js';

export type WorkRisk = 'trivial' | 'small' | 'normal' | 'high';
export type ModeAdviceKind = 'none' | 'downgrade' | 'upgrade' | 'missing-context';

// High-risk patterns: word-boundary matched to avoid matching auth-domain
// *variable names* like `authClient` while still matching domain terms
// like `auth`, `authentication`, `authorize`. Domain forms are explicitly
// listed via the regex alternation.
const HIGH_REGEXPS: readonly RegExp[] = [
  /\bauth(?:n|z|entication|enticate|orize|orization)?\b/,
  /\blogin\b/,
  /\bpassword\b/,
  /\bsession\b/,
  /\bcsrf\b/,
  /\bxss\b/,
  /\bsecret(s)?\b/,
  /\bsecurity\b/,
  /\bpermission(s)?\b/,
  /\bcredential(s)?\b/,
  /\bmigration(s)?\b/,
  /\bdatabase\b/,
  /\bdb schema\b/,
  /\bconfig schema\b/,
  /\bgit hook(s)?\b/,
  /\bpublic api\b/,
  /\bbreaking change(s)?\b/,
  /\bencrypt\b/,
  /\bdecrypt\b/,
  /\btoken rotation\b/,
  /\boauth\b/,
  /\bjwt\b/,
  /\bsql\b/,
  /\bnosql\b/,
  /\bpostgres\b/,
  /\bmongodb\b/,
  /\bredis\b/,
];

// High-risk patterns also matched on the word "hook" only if not "webhook"
const HOOK_RE = /\bhook(s)?\b/;
const WEBHOOK_RE = /\bwebhook(s)?\b/;

const TRIVIAL_PATTERNS: readonly string[] = [
  'typo',
  'spelling mistake',
  'fix typo',
  'rename',
  'dead code',
  'unused import',
  'remove unused',
  'formatting',
  'fix indent',
  'reformat',
  'whitespace',
  'comment only',
  'update comment',
  'fix comment',
  'add comment',
];

const SMALL_PATTERNS: readonly string[] = [
  'helper',
  'single bug',
  'null check',
  'optional chain',
  'add log',
  'console.log',
  'logger',
  'bump version',
  'import order',
  'add missing export',
];

const FILE_PATH_RE = /(?:src\/|lib\/|\.ts|\.tsx|\.js|\.jsx|\.py|\.go|\.rs)\b/i;
const AREA_OR_MODULE_RE =
  /\b(area|module|component|page|screen|route|endpoint|api|service|store|hook|cli|config|docs?|tests?|auth|login|database|schema|ui|workflow|orchestrator|planner|implementer)\b/i;
const VALIDATION_HINT_RE =
  /\b(test(s|ed|ing)?|verify|validate|validation|typecheck|lint|passing|assert|expect|acceptance|criteria|done when|done if|should)\b/i;
const VAGUE_RE =
  /^(improve|fix|make better|make it better|make it work|update|enhance)\s*(it|this|that)?\s*$/i;

const MODE_ORDER: readonly WorkflowMode[] = ['instant', 'quick', 'standard', 'speckit'];

function riskToMode(risk: WorkRisk): WorkflowMode {
  return ({ trivial: 'instant', small: 'quick', normal: 'standard', high: 'speckit' } as const)[
    risk
  ];
}

function modeIndex(mode: WorkflowMode): number {
  return MODE_ORDER.indexOf(mode);
}

export type AdvisorResult = {
  kind: ModeAdviceKind;
  risk: WorkRisk;
  currentMode: WorkflowMode;
  suggestedMode: WorkflowMode;
  confidence: number;
  factors: string[];
  missing: string[];
};

function classifyRisk(
  lower: string,
  wordCount: number,
): { risk: WorkRisk; confidence: number; factors: string[] } {
  const factors: string[] = [];

  for (const re of HIGH_REGEXPS) {
    if (re.test(lower)) {
      factors.push(`matched: ${re.source}`);
    }
  }
  // hook is high-risk unless it's webhook
  if (HOOK_RE.test(lower) && !WEBHOOK_RE.test(lower)) {
    factors.push('matched: hook');
  }

  if (factors.length > 0) {
    return { risk: 'high', confidence: 0.85 + Math.min(factors.length - 1, 3) * 0.04, factors };
  }

  for (const p of TRIVIAL_PATTERNS) {
    if (lower.includes(p)) {
      factors.push(`matched: ${p}`);
    }
  }
  if (factors.length > 0 && wordCount <= 14) {
    return { risk: 'trivial', confidence: 0.8 + Math.min(factors.length - 1, 2) * 0.05, factors };
  }
  // Trivial keyword present but long prompt → normal risk
  if (factors.length > 0) {
    factors.length = 0;
  }

  for (const p of SMALL_PATTERNS) {
    if (lower.includes(p)) {
      factors.push(`matched: ${p}`);
    }
  }
  if (factors.length > 0) {
    return { risk: 'small', confidence: 0.7, factors };
  }

  if (FILE_PATH_RE.test(lower) && wordCount <= 20) {
    factors.push('explicit file path');
    return { risk: 'small', confidence: 0.7, factors };
  }

  return { risk: 'normal', confidence: 0.6, factors };
}

function detectMissing(prompt: string, lower: string, wordCount: number): string[] {
  const missing: string[] = [];

  if (wordCount === 0) return missing;

  if (VAGUE_RE.test(prompt.trim())) {
    missing.push('vague target');
    return missing;
  }

  if (wordCount > 5 && !FILE_PATH_RE.test(lower) && !AREA_OR_MODULE_RE.test(lower)) {
    missing.push('no area/file/module');
  }

  if (wordCount > 5 && !VALIDATION_HINT_RE.test(lower)) {
    missing.push('no validation hint');
  }

  if (
    wordCount > 8 &&
    !VALIDATION_HINT_RE.test(lower) &&
    !lower.includes('when') &&
    !lower.includes('so that')
  ) {
    missing.push('no done criteria');
  }

  return missing;
}

export function adviseMode(prompt: string, currentMode: WorkflowMode): AdvisorResult {
  const wordCount = prompt.trim().split(/\s+/).filter(Boolean).length;
  const lower = prompt.toLowerCase();

  if (wordCount === 0) {
    return {
      kind: 'none',
      risk: 'normal',
      currentMode,
      suggestedMode: currentMode,
      confidence: 0,
      factors: [],
      missing: [],
    };
  }

  const { risk, confidence, factors } = classifyRisk(lower, wordCount);
  const suggestedMode = riskToMode(risk);
  const missing = detectMissing(prompt, lower, wordCount);

  // Missing-context takes priority over mode matching — emit even when modes match
  if (
    missing.length > 0 &&
    (wordCount <= 5 ||
      missing.includes('vague target') ||
      missing.includes('no area/file/module') ||
      (risk === 'normal' &&
        (missing.includes('no validation hint') || missing.includes('no done criteria'))))
  ) {
    return {
      kind: 'missing-context',
      risk,
      currentMode,
      suggestedMode,
      confidence,
      factors,
      missing,
    };
  }

  if (suggestedMode === currentMode) {
    return { kind: 'none', risk, currentMode, suggestedMode, confidence, factors, missing };
  }

  const isDowngrade = modeIndex(suggestedMode) < modeIndex(currentMode);
  const isUpgrade = modeIndex(suggestedMode) > modeIndex(currentMode);

  if ((isDowngrade || isUpgrade) && confidence >= 0.65) {
    const kind: ModeAdviceKind = isDowngrade ? 'downgrade' : 'upgrade';
    return { kind, risk, currentMode, suggestedMode, confidence, factors, missing };
  }

  if (missing.length > 0) {
    return {
      kind: 'missing-context',
      risk,
      currentMode,
      suggestedMode,
      confidence,
      factors,
      missing,
    };
  }

  return { kind: 'none', risk, currentMode, suggestedMode, confidence, factors, missing };
}

export function formatAdvisoryText(result: AdvisorResult): string {
  if (result.kind === 'none') return '';

  if (result.kind === 'missing-context') {
    const first = result.missing[0] ?? 'missing context';
    return `advisor: ${first} · ${result.currentMode} may drift`;
  }

  const label = riskLabel(result.risk);
  const verb = result.kind === 'downgrade' ? 'likely' : 'consider';
  return `advisor: ${verb} ${result.suggestedMode} · ${label}`;
}

function riskLabel(risk: WorkRisk): string {
  return (
    {
      trivial: 'trivial edit',
      small: 'small/localized',
      normal: 'standard scope',
      high: 'security/config risk',
    } as const
  )[risk];
}
