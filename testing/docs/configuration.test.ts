import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/core/schemas/config.js';
import { loadConfig } from '../../src/core/config/load/io.js';
import {
  ADMITTED_API_PROVIDER_IDS,
  API_PROVIDER_CATALOG,
  API_PROVIDER_VERDICT_CANDIDATE_PATHS,
  FORBIDDEN_API_PROVIDER_IDS,
} from '../../src/core/providers/api-provider-catalog.js';
import { KNOWN_MODELS } from '../../src/core/providers/known-models.js';
import { writeConfigYamlText } from '#testing/helpers/config-io.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const projectRoot = join(import.meta.dirname, '../..');
const configurationPath = join(projectRoot, 'docs/CONFIGURATION.md');
const apiKeysPath = join(projectRoot, 'docs/API-KEYS.md');
const configurationDoc = readFileSync(configurationPath, 'utf8');
const apiKeysDoc = readFileSync(apiKeysPath, 'utf8');
const readmeDoc = readFileSync(join(projectRoot, 'README.md'), 'utf8');
const usageExamplesDoc = readFileSync(join(projectRoot, 'docs/USAGE-EXAMPLES.md'), 'utf8');

// The docs are read by people who then run the product, so every example the
// docs present as a whole config is checked with the loader the product runs,
// not with the schema alone: only the loader applies default merging, key
// normalization and cross-field validation.
function loadConfigText(yamlText: string): Config {
  const projectDir = createTempDir('doc-config');
  try {
    writeConfigYamlText(projectDir, yamlText);
    const result = loadConfig(projectDir);
    expect(result.warnings).toEqual([]);
    return result.config;
  } finally {
    cleanupTempDir(projectDir);
  }
}

// Credential presence is a property of the machine, not of the documented
// example; stubbing the catalog credentials keeps the doc corpus asserting
// shape identically with or without real keys on the box.
beforeAll(() => {
  for (const descriptor of Object.values(API_PROVIDER_CATALOG)) {
    if (!descriptor.credentialEnv) continue;
    vi.stubEnv(descriptor.credentialEnv, `${descriptor.credentialPrefix ?? ''}doc-example-test`);
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const EXCLUDED_DOC_IDS = [
  ...FORBIDDEN_API_PROVIDER_IDS,
  ...API_PROVIDER_VERDICT_CANDIDATE_PATHS.map((candidate) => candidate.id),
] as const;

const EXCLUDED_OFFERINGS_HEADING = '### Excluded API offerings';

// REQ-061: the API-side half of FORBIDDEN_API_PROVIDER_IDS needs a dated
// defer/reject/generic-only verdict here, exactly as the CLI half has one in
// PLANNERS-AND-IMPLEMENTERS.md.
const EXCLUDED_API_OFFERING_IDS = [
  'minimax-token-plan',
  'kimi-code',
  'zai-coding-plan',
  'alibaba-coding-plan',
  'siliconflow',
  'cloudflare',
  'github-models',
  'huggingface',
  'vllm',
  'localai',
  'local-openai',
  'sambanova',
  'nvidia-nim',
] as const;

const EXCLUDED_VERDICTS = ['DEFER', 'REJECT', 'GENERIC-ONLY'];

// `auto` and model absence are the same instruction for a `cli` runner, so no
// sentence may deny one of them. Only the `api` half of the doc may say `auto`
// is refused (a custom provider with no catalog default). Matching the denial
// family rather than one phrasing keeps a reworded contradiction from landing.
const CLI_AUTO_DENIALS = [
  /`?auto`?[^.]{0,80}\bis not a\b[^.]{0,40}\bmodel\b/i,
  /\bnot a (valid )?model\b/i,
  /\b(reject|refuse|disallow|forbid)\w*\b[^.]{0,40}`?(model: )?auto`?/i,
  /`?(model: )?auto`?[^.]{0,80}\b(is|are)\b[^.]{0,20}\b(rejected|invalid|unsupported|unaccepted|disallowed|forbidden)\b/i,
  /`?(model: )?auto`?[^.]{0,80}\bis not\b[^.]{0,20}\b(valid|supported|accepted|allowed|a model)\b/i,
  /\bomit\b[^.]{0,40}\binstead\b/i,
] as const;

// The denial family above guards how `auto` is described; this one guards how
// `model` requiredness is scoped. `model` is required for `api`, `shell`,
// `agent` and `agent-sdk` implementers and optional for `cli` ones, so a
// sentence promoting that to every runner kind is a doc-only claim the loader
// contradicts — the exact regression the `auto` patterns do not see.
const MODEL_REQUIREDNESS_OVERCLAIMS = [
  /\b(required|mandatory)\b[^.]{0,40}\bfor\b[^.]{0,20}\b(every|all|each|any)\b[^.]{0,20}\b(runner )?kinds?\b/i,
  /\b(every|all|each)\b[^.]{0,20}\b(runner )?kinds?\b[^.]{0,40}\b(requires?|needs?|must have)\b[^.]{0,20}\bmodel\b/i,
] as const;

// The `model` row exactly as it read before the fix, quoted from the
// regression: the fence is only worth having if it fires on this.
const REGRESSED_MODEL_ROW =
  "| `model` | string | — | Model identifier. Planner: optional. Implementer: required for every runner kind; use `auto` when you want the runner's default model. |";

function docSentences(doc: string): string[] {
  return doc
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=\.)\s+/))
    .map((sentence) => sentence.trim());
}

function modelRequirednessOverclaims(doc: string): string[] {
  return docSentences(doc).filter((sentence) =>
    MODEL_REQUIREDNESS_OVERCLAIMS.some((pattern) => pattern.test(sentence)),
  );
}

// Only a secret-shaped right-hand side is a leak: placeholder (`=<paste-…>`) and
// indirection (`="$(secret-manager get …)"`) forms must stay copyable in the docs.
const INLINE_CREDENTIAL_ASSIGNMENT =
  /(?:^|[^A-Z])(?:[A-Z0-9_]*API_KEY|SECRET|TOKEN)=['"]?(?:sk-|gsk_|tp-|[A-Za-z0-9][A-Za-z0-9_-]{15,})/m;
const INLINE_SECRET_PATTERNS = [
  /apiKey:\s*['"]?sk-/i,
  /apiKey:\s*['"]?gsk_/i,
  /apiKey:\s*['"]?tp-/i,
  /apiKey:\s*['"]?sk-cp-/i,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/,
  /\bsk-or-[A-Za-z0-9_-]{8,}/,
  /\bgsk_[A-Za-z0-9_-]{8,}/,
] as const;

function extractTaggedYamlBlocks(doc: string, tagPrefix: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const pattern = new RegExp(
    `<!-- ${tagPrefix}: ([a-z0-9-]+) -->\\n\`\`\`yaml\\n([\\s\\S]*?)\`\`\``,
    'g',
  );
  for (const match of doc.matchAll(pattern)) {
    const [, id, yaml] = match;
    if (id !== undefined && yaml !== undefined) {
      blocks.set(id, yaml.trim());
    }
  }
  return blocks;
}

const CONFIG_EXAMPLE_TAG = 'config-example: ';
const SHAPE_SKETCH_TAG = 'config-shape-sketch';

const CONFIG_EXAMPLE_DOCS = [
  { path: 'docs/CONFIGURATION.md', doc: configurationDoc },
  { path: 'README.md', doc: readmeDoc },
  { path: 'docs/USAGE-EXAMPLES.md', doc: usageExamplesDoc },
] as const;

// A fence carrying a top-level `version:` key is a whole config, not a
// fragment: it is what a reader copies into .splitbrief/config.yaml, so it must
// either load or say out loud that it is a sketch.
function wholeConfigFences(doc: string): { tag: string | undefined; body: string; line: number }[] {
  const fences: { tag: string | undefined; body: string; line: number }[] = [];
  const pattern = /(?:<!-- ([a-z0-9-]+(?:: [a-z0-9-]+)?) -->\n)?```yaml\n([\s\S]*?)```/g;
  for (const match of doc.matchAll(pattern)) {
    const body = match[2] ?? '';
    if (!/^version:/m.test(body)) continue;
    fences.push({
      tag: match[1],
      body,
      line: doc.slice(0, match.index).split('\n').length,
    });
  }
  return fences;
}

function extractMarkdownTable(doc: string, marker: string): string[][] {
  const markerIndex = doc.indexOf(marker);
  expect(markerIndex, `missing table marker ${marker}`).toBeGreaterThanOrEqual(0);
  const afterMarker = doc.slice(markerIndex + marker.length);
  const tableStart = afterMarker.indexOf('|');
  expect(tableStart, `missing table after ${marker}`).toBeGreaterThanOrEqual(0);
  const rawLines = afterMarker.slice(tableStart).split('\n');
  const tableLines: string[][] = [];
  for (const line of rawLines) {
    if (!line.trim().startsWith('|')) break;
    tableLines.push(
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    );
  }
  expect(tableLines.length, `table under ${marker} is empty`).toBeGreaterThan(1);
  return tableLines.slice(2);
}

function wrapMinimalApiConfig(runnerYaml: string): unknown {
  const parsed = YAML.parse(runnerYaml) as Record<string, unknown>;
  const planner = parsed.planner ?? { kind: 'cli', tool: 'claude-code' };
  const implementer = parsed.implementer ?? parsed;
  return {
    version: 3,
    planner,
    implementer,
    validation: { typecheck: true, lint: true, test: true },
    workflow: {
      approve: 'default',
      maxRetries: 3,
      git: { commitStrategy: 'none' },
      persistTranscript: true,
      compactionFormat: 'auto',
      mode: 'standard',
      taskReview: 'none',
    },
    theme: 'terminal',
    plannerEstimateReview: false,
    autoSplitOverflow: false,
  };
}

function collectRuntimeRecommendations() {
  return Object.entries(KNOWN_MODELS).flatMap(([provider, models]) =>
    (models ?? [])
      .filter((model) => model.recommendation === 'recommended')
      .map((model) => ({ provider, model: model.name })),
  );
}

function collectRuntimeCompatibleOnlyDefaults() {
  const admitted = new Set<string>(ADMITTED_API_PROVIDER_IDS);
  return Object.entries(KNOWN_MODELS).flatMap(([provider, models]) =>
    (models ?? [])
      .filter(
        (model) =>
          admitted.has(provider) && model.isDefault && model.recommendation === 'compatible-only',
      )
      .map((model) => ({ provider, model: model.name })),
  );
}

// The verdict table at the end of §20 must name every excluded offering, so the
// admitted scope stops where it begins.
function admittedApiSection(doc: string): string {
  const start = doc.indexOf('## 20. Admitted API providers');
  const end = doc.indexOf(EXCLUDED_OFFERINGS_HEADING);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return doc.slice(start, end);
}

function containsExcludedProviderId(doc: string, id: string): boolean {
  const pattern = new RegExp(`(?:^|[\`'"\\s:>|])${id}(?:$|[\`'"\\s,<.])`, 'i');
  return pattern.test(doc);
}

describe('configuration documentation', () => {
  it('documents every admitted API provider in the provider matrix', () => {
    const rows = extractMarkdownTable(configurationDoc, '<!-- api-provider-matrix -->');
    const documentedIds = rows.map((row) => row[0]);
    expect(documentedIds.toSorted()).toEqual([...ADMITTED_API_PROVIDER_IDS].toSorted());
  });

  it('loads every tagged minimal API YAML example through the real loader', () => {
    const blocks = extractTaggedYamlBlocks(configurationDoc, 'config-api-minimal');
    expect([...blocks.keys()].toSorted()).toEqual([...ADMITTED_API_PROVIDER_IDS].toSorted());

    for (const [providerId, yaml] of blocks) {
      const config = loadConfigText(YAML.stringify(wrapMinimalApiConfig(yaml)));

      const descriptor = API_PROVIDER_CATALOG[providerId as keyof typeof API_PROVIDER_CATALOG];
      const runner =
        descriptor.roles.includes('implementer') && !yaml.includes('planner:')
          ? config.implementer
          : config.planner;
      expect(runner.kind).toBe('api');
      if (runner.kind !== 'api') continue;
      expect(runner.provider).toBe(providerId);
      expect(runner.service).toBe(descriptor.service);
      expect(runner.offering).toBe(descriptor.offering);
    }
  });

  it('keeps runtime recommendation parity in the model catalog table', () => {
    const rows = extractMarkdownTable(configurationDoc, '<!-- api-model-catalog -->');
    const documentedRecommended = rows
      .filter((row) => row[2] === 'recommended')
      .map((row) => ({ provider: row[0], model: row[1] }));
    expect(documentedRecommended).toEqual(collectRuntimeRecommendations());
  });

  it('keeps compatible-only quality failures visible without a recommendation label', () => {
    const rows = extractMarkdownTable(configurationDoc, '<!-- api-model-catalog -->');
    const documentedCompatible = rows
      .filter((row) => row[2] === 'compatible-only')
      .map((row) => ({ provider: row[0], model: row[1] }));

    for (const entry of collectRuntimeCompatibleOnlyDefaults()) {
      expect(documentedCompatible).toContainEqual(entry);
    }

    for (const row of rows) {
      if (row[2] === 'compatible-only') {
        expect(row[2]).not.toBe('recommended');
      }
    }
  });

  it('documents auto as a working CLI model value, not a rejected one', () => {
    const offending = docSentences(configurationDoc)
      .filter((sentence) => /\bauto\b/i.test(sentence) && !/\bapi\b/i.test(sentence))
      .filter((sentence) => CLI_AUTO_DENIALS.some((pattern) => pattern.test(sentence)));

    expect(offending).toEqual([]);
    expect(configurationDoc).toContain('Omitting `model` and writing `model: auto` are equivalent');
  });

  it('scopes implementer model requiredness to the runner kinds that have it', () => {
    expect(modelRequirednessOverclaims(configurationDoc)).toEqual([]);
    expect(modelRequirednessOverclaims(REGRESSED_MODEL_ROW)).toEqual([
      "Implementer: required for every runner kind; use `auto` when you want the runner's default model.",
    ]);

    const cliImplementer = loadConfigText(
      YAML.stringify({
        version: 3,
        planner: { kind: 'cli', tool: 'codex' },
        implementer: { kind: 'cli', tool: 'codex' },
      }),
    ).implementer;
    expect(cliImplementer.kind).toBe('cli');
    expect(Object.hasOwn(cliImplementer, 'model')).toBe(false);
    expect(configurationDoc).toContain('optional for `cli`');
  });

  it('rejects excluded provider IDs and deferred verdict candidates in the docs', () => {
    const scopedDocs = `${admittedApiSection(configurationDoc)}\n${apiKeysDoc}`;
    for (const id of EXCLUDED_DOC_IDS) {
      expect(containsExcludedProviderId(scopedDocs, id), `found excluded id ${id}`).toBe(false);
    }
  });

  it('records a dated defer/reject/generic-only verdict for every excluded API offering', () => {
    const forbidden = new Set<string>(FORBIDDEN_API_PROVIDER_IDS);
    for (const id of EXCLUDED_API_OFFERING_IDS) {
      expect(forbidden.has(id), `${id} is not forbidden by the catalog`).toBe(true);
    }

    const rows = extractMarkdownTable(configurationDoc, '<!-- api-excluded-offerings -->');
    expect(rows.map((row) => row[0]?.replaceAll('`', '')).toSorted()).toEqual(
      [...EXCLUDED_API_OFFERING_IDS].toSorted(),
    );

    for (const row of rows) {
      const [id, verdict, asOf, reason] = row;
      expect(EXCLUDED_VERDICTS, `verdict for ${id}`).toContain(verdict);
      expect(asOf, `as-of for ${id}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect((reason ?? '').length, `reason for ${id}`).toBeGreaterThan(40);
    }
  });

  it('rejects inline credential assignments and copyable secret examples', () => {
    for (const doc of [configurationDoc, apiKeysDoc]) {
      expect(doc).not.toMatch(INLINE_CREDENTIAL_ASSIGNMENT);
      for (const pattern of INLINE_SECRET_PATTERNS) {
        expect(doc).not.toMatch(pattern);
      }
    }
  });

  it('documents normalized-origin trust for generic remote API examples', () => {
    expect(configurationDoc).toContain('<!-- config-api-generic-remote: remote -->');
    expect(configurationDoc).toMatch(/normalized[- ]origin trust/i);
    const genericYaml = extractTaggedYamlBlocks(configurationDoc, 'config-api-generic-remote').get(
      'remote',
    );
    expect(genericYaml).toBeDefined();
    if (genericYaml === undefined) return;
    expect(genericYaml).toMatch(/apiKey:\s*env:/);
    expect(genericYaml).not.toMatch(/apiKey:\s*sk-/);
  });

  it('documents credential env names and prefix validation for admitted remote providers', () => {
    const rows = extractMarkdownTable(configurationDoc, '<!-- api-provider-matrix -->');
    const byId = new Map(rows.map((row) => [row[0], row]));

    for (const providerId of ADMITTED_API_PROVIDER_IDS) {
      const descriptor = API_PROVIDER_CATALOG[providerId];
      const row = byId.get(providerId);
      expect(row, `missing matrix row for ${providerId}`).toBeDefined();
      if (row === undefined) continue;

      const cell = (index: number) => row[index]?.replaceAll('`', '') ?? '';
      expect(cell(1)).toBe(descriptor.service);
      expect(cell(2)).toBe(descriptor.offering);
      expect(cell(4)).toBe(descriptor.credentialEnv ?? '—');
      expect(cell(5)).toBe(descriptor.credentialPrefix ?? '—');
      expect(cell(6)).toBe(descriptor.roles.join(', '));
      expect(cell(7)).toBe(descriptor.billing);
    }
  });

  it('distinguishes local Ollama credentials from Ollama Cloud credentials', () => {
    expect(configurationDoc).toContain(
      '`OLLAMA_API_KEY` is never resolved or sent to local Ollama',
    );
    expect(configurationDoc).toContain('`apiKey: env:OLLAMA_LOCAL_API_KEY`');
    expect(configurationDoc).toContain('`ollama-cloud`');
    expect(apiKeysDoc).toContain('| Local Ollama | `OLLAMA_LOCAL_API_KEY` |');
    expect(apiKeysDoc).toContain('`apiKey: env:OLLAMA_LOCAL_API_KEY`');
    expect(apiKeysDoc).toContain('`OLLAMA_API_KEY` is never accepted or sent locally');
    expect(apiKeysDoc).toContain('| Ollama Cloud | `OLLAMA_API_KEY` |');
    expect(apiKeysDoc).not.toContain('Optional for secured local/proxy deployments');
    expect(apiKeysDoc).not.toContain('| Ollama | `OLLAMA_API_KEY` |');
  });

  it('documents the required API identity triple and named implementer profiles', () => {
    expect(configurationDoc).toMatch(/service.*offering/i);
    expect(configurationDoc).toMatch(/implementerProfiles/);
  });

  it('documents version 3 as the only accepted config version', () => {
    expect(configurationDoc).toMatch(/`version: 3`/);
    expect(configurationDoc).not.toMatch(/migrateConfig|migrateV1ToV2|migrateV2ToV3/);
    expect(configurationDoc).not.toMatch(/Deprecated v2/i);
    expect(configurationDoc).not.toMatch(/`--auto`/);
  });
});

describe('whole-config documentation examples', () => {
  const examples = CONFIG_EXAMPLE_DOCS.flatMap(({ path, doc }) =>
    wholeConfigFences(doc).map((fence) => ({ path, ...fence })),
  );
  const loadable = examples.filter(({ tag }) => tag?.startsWith(CONFIG_EXAMPLE_TAG));

  it('tags every documented whole config as a loadable example or a shape sketch', () => {
    const untagged = examples
      .filter(({ tag }) => tag !== SHAPE_SKETCH_TAG && !tag?.startsWith(CONFIG_EXAMPLE_TAG))
      .map(({ path, line }) => `${path}:${line}`);
    expect(untagged).toEqual([]);
  });

  it('keeps the loadable example set non-empty and uniquely named', () => {
    const ids = loadable.map(({ tag }) => tag?.slice(CONFIG_EXAMPLE_TAG.length));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.toSorted()).toEqual([...new Set(ids)].toSorted());
  });

  it.each(
    loadable.map((example) => [`${example.path}:${example.line}`, example.body] as const),
  )('loads %s through the real loader', (_label, body) => {
    expect(loadConfigText(body).version).toBe(3);
  });
});

describe('API key documentation', () => {
  it('points remote credential guidance at environment variables instead of inline config secrets', () => {
    expect(apiKeysDoc).toMatch(/environment variable/i);
    expect(apiKeysDoc).not.toMatch(/apiKey:\s*sk-/i);
    expect(apiKeysDoc).toMatch(/normalized[- ]origin trust/i);
  });

  it('teaches an export that actually assigns a value', () => {
    expect(apiKeysDoc).toMatch(/^export ANTHROPIC_API_KEY=\S/m);
  });

  it('lists admitted provider credential env vars without inline assignments', () => {
    for (const providerId of ADMITTED_API_PROVIDER_IDS) {
      const descriptor = API_PROVIDER_CATALOG[providerId];
      if (descriptor.credentialEnv) {
        expect(apiKeysDoc).toContain(descriptor.credentialEnv);
      }
    }
    expect(apiKeysDoc).not.toMatch(INLINE_CREDENTIAL_ASSIGNMENT);
  });

  it('documents prefix validation without promoting excluded offerings', () => {
    expect(apiKeysDoc).toMatch(/prefix/i);
    expect(apiKeysDoc).toContain('sk-ant-');
    expect(apiKeysDoc).toContain('sk-or-');
    for (const id of EXCLUDED_DOC_IDS) {
      expect(containsExcludedProviderId(apiKeysDoc, id), `found excluded id ${id}`).toBe(false);
    }
  });
});
