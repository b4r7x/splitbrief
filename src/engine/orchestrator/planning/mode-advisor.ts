import { WORKFLOW_MODES, type WorkflowMode } from '../../../core/schemas/enums.js';

export type WorkRisk = 'trivial' | 'small' | 'normal' | 'high';
export type ModeAdviceKind = 'none' | 'downgrade' | 'upgrade' | 'missing-context' | 'stop';

// High-risk patterns: word-boundary matched to avoid matching auth-domain
// *variable names* like `authClient` while still matching domain terms
// like `auth`, `authentication`, `authorize`. Domain forms are explicitly
// listed via the regex alternation. They read prose only: fenced code, a code
// span, a path and a kebab-case name are dropped first, and `\b` already
// rejects snake_case.
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

const FENCE_LINE_RE = /^ {0,3}(?:`{3,}|~{3,})/;
const CODE_SPAN_RE = /(`+)[^`\n]*?\1/g;
const PATH_RE = /(?<!\S)\S*\/\S*/g;
const KEBAB_NAME_RE = /\b\w+(?:-\w+)+/g;

// Trivial and small signals are whole words of the same prose, with the inflections a prompt
// uses spelled out: `typography` is not a typo, and `rename-session` is a name, not a rename.
const TRIVIAL_REGEXPS: readonly RegExp[] = [
  /\btypos?\b/,
  /\bspelling mistakes?\b/,
  /\bfix typos?\b/,
  /\brename[sd]?\b/,
  /\bdead code\b/,
  /\bunused imports?\b/,
  /\bremove unused\b/,
  /\bformatting\b/,
  /\bfix indent(?:s|ation)?\b/,
  /\breformat(?:s|ted|ting)?\b/,
  /\bwhitespace\b/,
  /\bcomment only\b/,
  /\bupdate comments?\b/,
  /\bfix comments?\b/,
  /\badd comments?\b/,
];

const SMALL_REGEXPS: readonly RegExp[] = [
  /\bhelpers?\b/,
  /\bsingle bug\b/,
  /\bnull checks?\b/,
  /\boptional chain(?:s|ing)?\b/,
  /\badd log(?:s|ging)?\b/,
  /\bconsole\.log\b/,
  /\bloggers?\b/,
  /\bbump versions?\b/,
  /\bimport order\b/,
  /\badd missing exports?\b/,
];

const FILE_PATH_RE = /(?:src\/|lib\/|\.ts|\.tsx|\.js|\.jsx|\.py|\.go|\.rs)\b/i;
const AREA_OR_MODULE_RE =
  /\b(area|module|component|page|screen|route|endpoint|api|service|store|hook|cli|config|docs?|tests?|auth|login|database|schema|ui|workflow|orchestrator|planner|implementer)\b/i;
const VALIDATION_HINT_RE =
  /\b(test(s|ed|ing)?|verify|validate|validation|typecheck|lint|passing|assert|expect|acceptance|criteria|done when|done if|should)\b/i;
const VAGUE_RE =
  /^(improve|fix|make better|make it better|make it work|update|enhance)\s*(it|this|that)?\s*$/i;

function riskToMode(risk: WorkRisk): WorkflowMode {
  return ({ trivial: 'quick', small: 'quick', normal: 'standard', high: 'speckit' } as const)[risk];
}

function modeIndex(mode: WorkflowMode): number {
  return WORKFLOW_MODES.indexOf(mode);
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

// A fence that never closes runs to the end, as it renders.
function withoutFencedCode(text: string): string {
  const prose: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const marker = FENCE_LINE_RE.exec(line)?.[0].trim() ?? null;
    if (fence === null && marker === null) {
      prose.push(line);
      continue;
    }
    if (fence === null) fence = marker;
    else if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length) {
      fence = null;
    }
  }
  return prose.join('\n');
}

function classifyRisk(
  lower: string,
  wordCount: number,
): { risk: WorkRisk; confidence: number; factors: string[] } {
  const factors: string[] = [];
  const prose = withoutFencedCode(lower)
    .replace(CODE_SPAN_RE, ' ')
    .replace(PATH_RE, ' ')
    .replace(KEBAB_NAME_RE, ' ');

  for (const re of HIGH_REGEXPS) {
    if (re.test(prose)) {
      factors.push(`matched: ${re.source}`);
    }
  }
  if (HOOK_RE.test(prose) && !WEBHOOK_RE.test(prose)) {
    factors.push('matched: hook');
  }

  if (factors.length > 0) {
    return { risk: 'high', confidence: 0.85 + Math.min(factors.length - 1, 3) * 0.04, factors };
  }

  for (const re of TRIVIAL_REGEXPS) {
    if (re.test(prose)) {
      factors.push(`matched: ${re.source}`);
    }
  }
  if (factors.length > 0 && wordCount <= 14) {
    return { risk: 'trivial', confidence: 0.8 + Math.min(factors.length - 1, 2) * 0.05, factors };
  }
  // Trivial keyword present but long prompt means normal risk
  if (factors.length > 0) {
    factors.length = 0;
  }

  for (const re of SMALL_REGEXPS) {
    if (re.test(prose)) {
      factors.push(`matched: ${re.source}`);
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

/** The advice a run's saved inputs earn today: its prompt's advice, never a count of its briefs. */
export function adviseRun(run: {
  feature: string;
  plannerContext?: string | undefined;
  mode: WorkflowMode;
}): AdvisorResult {
  return adviseMode([run.feature, run.plannerContext].filter(Boolean).join('\n\n'), run.mode);
}

export function formatAdvisoryText(result: AdvisorResult): string {
  if (result.kind === 'none') return '';

  if (result.kind === 'missing-context') {
    const first = result.missing[0] ?? 'missing context';
    return `advisor: ${first} · ${result.currentMode} may drift`;
  }

  // Only a run logged before count-only advice was removed still carries a `stop` verdict.
  if (result.kind === 'stop') return `advisor: ${result.factors.join(', ')} · split the work`;

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
