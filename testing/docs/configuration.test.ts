import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigSchema, type Config } from '../../src/core/schemas/config.js';
import { loadConfig } from '../../src/core/config/load/io.js';
import {
  ADMITTED_API_PROVIDER_IDS,
  API_PROVIDER_CATALOG,
} from '../../src/core/providers/api-provider-catalog.js';
import { FORBIDDEN_API_PROVIDER_IDS } from '../../src/core/providers/api-provider-verdicts.js';
import { KNOWN_MODELS } from '../../src/core/providers/known-models.js';
import { narrowRecord } from '../../src/utils/type-guards.js';
import { writeConfigYamlText } from '#testing/helpers/config-io.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const projectRoot = join(import.meta.dirname, '../..');

// Enumerating the doc tree rather than a hand-listed set is what makes the
// example gate exhaustive: a new doc is covered the moment it is added.
const DOC_PATHS = [
  'README.md',
  ...readdirSync(join(projectRoot, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`),
].toSorted();

const docs = new Map(
  DOC_PATHS.map((path) => [path, readFileSync(join(projectRoot, path), 'utf8')]),
);

function doc(path: string): string {
  const text = docs.get(path);
  if (text === undefined) throw new Error(`missing doc ${path}`);
  return text;
}

const configurationDoc = doc('docs/CONFIGURATION.md');
const apiKeysDoc = doc('docs/API-KEYS.md');

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

const EXCLUDED_DOC_IDS = FORBIDDEN_API_PROVIDER_IDS;

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
// `agent` implementers and optional for `cli` ones, so a
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

const SHAPE_SKETCH_TAG = 'config-shape-sketch';
const CONFIG_TOP_LEVEL_KEYS = new Set(Object.keys(ConfigSchema.shape));

interface DocConfigFence {
  label: string;
  body: string;
  parsed: Record<string, unknown>;
}

// A fence that does not parse is a fence no gate can read, so it is collected
// rather than skipped: silently dropping it is how an example escapes checking.
const UNPARSEABLE_YAML_FENCES: string[] = [];

// A YAML fence naming any top-level config key is something a reader pastes
// into .splitbrief/config.yaml, whether it is a whole config or one section of
// one. Both are checked; only a fence that declares itself pseudo-YAML with
// `<!-- config-shape-sketch -->` opts out.
function configFences(path: string): DocConfigFence[] {
  const text = doc(path);
  const fences: DocConfigFence[] = [];
  for (const match of text.matchAll(/(?:<!-- ([^>]*?) -->\n)?```yaml\n([\s\S]*?)```/g)) {
    const [, tag, body = ''] = match;
    const line = text.slice(0, match.index).split('\n').length + (tag === undefined ? 0 : 1);
    let parsed: unknown;
    try {
      parsed = YAML.parse(body);
    } catch {
      UNPARSEABLE_YAML_FENCES.push(`${path}:${line}`);
      continue;
    }
    const record = narrowRecord(parsed);
    if (!record || !Object.keys(record).some((key) => CONFIG_TOP_LEVEL_KEYS.has(key))) continue;
    if (tag === SHAPE_SKETCH_TAG) continue;
    fences.push({ label: `${path}:${line}`, body, parsed: record });
  }
  return fences;
}

const DOC_CONFIG_FENCES = DOC_PATHS.flatMap(configFences);

// A section fence is loaded the way a reader uses it: dropped into a config
// whose other sections come from the defaults the loader merges in.
function loadDocFence(fence: DocConfigFence): Config {
  return loadConfigText(/^version:/m.test(fence.body) ? fence.body : `version: 3\n${fence.body}`);
}

function apiRunnerBlocks(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(apiRunnerBlocks);
  const record = narrowRecord(value);
  if (!record) return [];
  const nested = Object.values(record).flatMap(apiRunnerBlocks);
  return record['kind'] === 'api' ? [record, ...nested] : nested;
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

    const recommendedKeys = new Set(
      rows.filter((row) => row[2] === 'recommended').map((row) => `${row[0]}/${row[1]}`),
    );
    const collidingKeys = documentedCompatible
      .map((entry) => `${entry.provider}/${entry.model}`)
      .filter((key) => recommendedKeys.has(key));
    expect(collidingKeys).toEqual([]);
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

  // The generic remote example used to teach `apiKey: env:VAR`, which the
  // loader refuses for a provider the catalog does not know — the doc taught
  // the one credential shape a custom provider cannot use. It must carry an
  // inline placeholder instead, and it must still be free of a real secret.
  it('teaches the inline credential a custom remote provider actually accepts', () => {
    expect(configurationDoc).toContain('<!-- config-api-generic-remote: remote -->');
    expect(configurationDoc).toMatch(/normalized[- ]origin trust/i);
    const genericYaml = extractTaggedYamlBlocks(configurationDoc, 'config-api-generic-remote').get(
      'remote',
    );
    expect(genericYaml).toBeDefined();
    if (genericYaml === undefined) return;
    expect(genericYaml).not.toMatch(/apiKey:\s*env:/);
    expect(genericYaml).toMatch(/apiKey:\s*<[^>]+>/);
    expect(loadConfigText(`version: 3\n${genericYaml}`).implementer.kind).toBe('api');
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

  it('keeps OLLAMA_API_KEY off the local Ollama credential row', () => {
    expect(configurationDoc).toContain(
      '`OLLAMA_API_KEY` is never resolved or sent to local Ollama',
    );
    expect(configurationDoc).toContain('`apiKey: env:OLLAMA_LOCAL_API_KEY`');
    expect(apiKeysDoc).toContain('| Local Ollama | `OLLAMA_LOCAL_API_KEY` |');
    expect(apiKeysDoc).toContain('`apiKey: env:OLLAMA_LOCAL_API_KEY`');
    expect(apiKeysDoc).toContain('`OLLAMA_API_KEY` is never accepted or sent locally');
    expect(apiKeysDoc).not.toContain('| Ollama Cloud | `OLLAMA_API_KEY` |');
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

describe('documentation config examples', () => {
  it('finds config examples across the whole doc tree', () => {
    const paths = new Set(DOC_CONFIG_FENCES.map((fence) => fence.label.split(':')[0]));
    expect(DOC_CONFIG_FENCES.length).toBeGreaterThan(50);
    expect(paths.size).toBeGreaterThan(5);
    expect(paths).toContain('docs/CONFIGURATION.md');
    expect(paths).toContain('docs/GETTING-STARTED.md');
    expect(paths).toContain('README.md');
  });

  it('parses every yaml fence in the doc tree', () => {
    expect(UNPARSEABLE_YAML_FENCES).toEqual([]);
  });

  it.each(DOC_CONFIG_FENCES.map((fence) => [fence.label, fence] as const))(
    'loads %s through the real loader',
    (_label, fence) => {
      expect(loadDocFence(fence).version).toBe(3);
    },
  );

  // Loading alone does not prove the example is honest: the loader merges the
  // default implementer, so an `ollama` block that omits service/offering loads
  // by accident of matching the default. The doc's own rule — every `kind: api`
  // block declares the identity triple — is checked against the fence text.
  it('declares the API identity triple in every documented kind: api block', () => {
    const incomplete = DOC_CONFIG_FENCES.flatMap((fence) =>
      apiRunnerBlocks(fence.parsed)
        .filter((block) => block['service'] === undefined || block['offering'] === undefined)
        .map(() => fence.label),
    );
    expect(incomplete).toEqual([]);
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
