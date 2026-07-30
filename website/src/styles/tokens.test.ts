import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitbriefDark, splitbriefDocsLight } from '../design/shiki-themes.js';

type CssRule = {
  selector: string;
  tokens: ReadonlyMap<string, string>;
};

type TokenContract = {
  minimum: number;
  role: string;
  token: string;
};

type ShikiSetting = {
  scope?: readonly string[];
  settings: {
    foreground?: string;
  };
};

const websiteRoot = process.cwd();
const cssSource = readFileSync(resolve(websiteRoot, 'src/styles/tokens.css'), 'utf8');
const landingSource = readFileSync(resolve(websiteRoot, 'src/routes/index.tsx'), 'utf8');
const evidenceSource = readFileSync(
  resolve(websiteRoot, '../docs/design/website/AA-TABLE.md'),
  'utf8',
);

const surfaceTokens = ['--ground', '--surface-1', '--surface-2'];
const tokenContracts: TokenContract[] = [
  { token: '--fg', role: 'Normal text', minimum: 4.5 },
  { token: '--dim', role: 'Normal text / comments', minimum: 4.5 },
  { token: '--planner', role: 'Non-text only', minimum: 3 },
  { token: '--planner-text', role: 'Normal text', minimum: 4.5 },
  { token: '--implementer', role: 'Normal text', minimum: 4.5 },
  { token: '--pin', role: 'Non-text selection', minimum: 3 },
  { token: '--focus', role: 'Non-text focus', minimum: 3 },
  { token: '--grid-functional', role: 'Non-text boundary', minimum: 3 },
];

function requiredCapture(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`Missing capture ${index} in ${match[0]}`);
  }
  return value;
}

function parseCssRules(source: string): CssRule[] {
  const rules: CssRule[] = [];
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, '');

  for (const ruleMatch of uncommented.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const tokens = new Map<string, string>();
    const body = requiredCapture(ruleMatch, 2);

    for (const tokenMatch of body.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
      tokens.set(requiredCapture(tokenMatch, 1), requiredCapture(tokenMatch, 2).trim());
    }

    if (tokens.size > 0) {
      rules.push({
        selector: requiredCapture(ruleMatch, 1).replace(/\s+/g, ' ').trim(),
        tokens,
      });
    }
  }

  return rules;
}

function findThemeRule(rules: CssRule[], selectorFragment: string): CssRule {
  const matches = rules.filter(
    ({ selector, tokens }) => selector.includes(selectorFragment) && tokens.has('--ground'),
  );
  const rule = matches[0];
  if (matches.length !== 1 || rule === undefined) {
    throw new Error(
      `Expected one token rule containing ${selectorFragment}, found ${matches.length}`,
    );
  }
  return rule;
}

function readToken(rule: CssRule, token: string): string {
  const value = rule.tokens.get(token);
  if (value === undefined) {
    throw new Error(`Missing ${token} in ${rule.selector}`);
  }
  return value;
}

function linearChannel(channel: number): number {
  const encoded = channel / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: string): number {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  if (match === null) {
    throw new Error(`Expected a six-digit hex color, received ${color}`);
  }
  const red = linearChannel(Number.parseInt(requiredCapture(match, 1), 16));
  const green = linearChannel(Number.parseInt(requiredCapture(match, 2), 16));
  const blue = linearChannel(Number.parseInt(requiredCapture(match, 3), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function documentedRow(theme: string, token: string): string[] {
  const row = evidenceSource
    .split('\n')
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .find(([rowTheme, rowToken]) => rowTheme === theme && rowToken === `\`${token}\``);
  if (row === undefined) {
    throw new Error(`Missing ${theme} ${token} row in AA-TABLE.md`);
  }
  return row;
}

function commentColor(settings: readonly ShikiSetting[]): string {
  const color = settings.find(({ scope }) => scope?.includes('comment'))?.settings.foreground;
  if (color === undefined) {
    throw new Error('Shiki theme is missing a comment foreground');
  }
  return color.toLowerCase();
}

const rules = parseCssRules(cssSource);
const darkRule = findThemeRule(rules, '.landing-shell');
const lightRule = findThemeRule(rules, '[data-theme="light"]');
const themes = [
  {
    name: 'Dark',
    rule: darkRule,
    shikiForeground: splitbriefDark.colors['editor.foreground'],
    shikiSettings: splitbriefDark.settings,
  },
  {
    name: 'Docs light',
    rule: lightRule,
    shikiForeground: splitbriefDocsLight.colors['editor.foreground'],
    shikiSettings: splitbriefDocsLight.settings,
  },
];

describe('design token contrast', () => {
  it('proves every semantic color against all three surfaces and records the evidence', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    const violations: string[] = [];

    for (const theme of themes) {
      for (const contract of tokenContracts) {
        const foreground = readToken(theme.rule, contract.token);
        const ratios = surfaceTokens.map((surfaceToken) => {
          const ratio = contrastRatio(foreground, readToken(theme.rule, surfaceToken));
          if (ratio < contract.minimum) {
            violations.push(
              `${theme.name} ${contract.token} on ${surfaceToken}: ${ratio.toFixed(3)} < ${contract.minimum}`,
            );
          }
          return ratio.toFixed(3);
        });

        expect(documentedRow(theme.name, contract.token)).toEqual([
          theme.name,
          `\`${contract.token}\``,
          contract.role,
          `\`${foreground.toUpperCase()}\``,
          ...ratios,
          `≥ ${contract.minimum.toFixed(1)}:1`,
          'Pass',
        ]);
      }

      expect(theme.shikiForeground.toLowerCase()).toBe(readToken(theme.rule, '--fg'));
      expect(commentColor(theme.shikiSettings)).toBe(readToken(theme.rule, '--dim'));
    }

    expect(violations).toEqual([]);
  });

  it('keeps decorative channels exempt and the light theme behind the docs boundary', () => {
    for (const theme of themes) {
      const decorative = readToken(theme.rule, '--grid-decorative');
      const ratios = surfaceTokens.map((surfaceToken) =>
        contrastRatio(decorative, readToken(theme.rule, surfaceToken)).toFixed(3),
      );

      expect(decorative).not.toBe(readToken(theme.rule, '--grid-functional'));
      expect(readToken(theme.rule, '--wash-planner')).toMatch(/\/ 8%\)$/);
      expect(readToken(theme.rule, '--wash-implementer')).toMatch(/\/ 8%\)$/);
      expect(documentedRow(theme.name, '--grid-decorative')).toEqual([
        theme.name,
        '`--grid-decorative`',
        'Decorative grid',
        `\`${decorative.toUpperCase()}\``,
        ...ratios,
        'Exempt',
        'No semantic use',
      ]);
    }

    expect(darkRule.selector).toBe(':root, [data-theme="dark"], .landing-shell');
    expect(lightRule.selector).toBe(
      ':where([data-theme="light"] .docs-shell, .docs-shell[data-theme="light"])',
    );
    expect(landingSource).toContain('className="landing-shell"');
    expect(landingSource).toContain('data-theme="dark"');
  });
});
