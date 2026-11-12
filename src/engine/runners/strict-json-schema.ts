import { isRecord } from '../../utils/type-guards.js';

const UNPROVEN_COMPOSITIONS = ['oneOf', 'allOf', 'not'] as const;

function strictNode(node: unknown): boolean {
  if (!isRecord(node)) return true;
  if (UNPROVEN_COMPOSITIONS.some((key) => key in node)) return false;
  if ('maxItems' in node) return false;
  const properties = isRecord(node.properties) ? node.properties : undefined;
  if (node.type === 'object') {
    const required = Array.isArray(node.required) ? node.required : [];
    if (node.additionalProperties !== false || properties === undefined) return false;
    if (Object.keys(properties).some((key) => !required.includes(key))) return false;
  }
  return [
    ...(properties === undefined ? [] : Object.values(properties)),
    ...(Array.isArray(node.anyOf) ? node.anyOf : []),
    ...(isRecord(node.$defs) ? Object.values(node.$defs) : []),
    ...(isRecord(node.definitions) ? Object.values(node.definitions) : []),
    node.items,
  ].every(strictNode);
}

/**
 * Whether OpenAI strict mode, which codex `--output-schema` uses (live probe, 0.157.1), takes the
 * schema. It answers HTTP 400 for an object that is open, lacks `properties` or has a key outside
 * `required`, and it takes only an object at the root. The live probe on 2026-10-06 rejected
 * `oneOf` and accepted `anyOf` of closed objects. `oneOf`, `allOf` and `not` count as rejected;
 * a `$ref` target is checked where `$defs` declares it. The live record on 2026-11-12 showed that
 * a strict grammar with `maxItems` permits no valid answer when the request needs one entry more,
 * and the model can then write inside the last entry up to the output cap, so a node with
 * `maxItems` counts as rejected too.
 */
export function isStrictJsonSchema(json: Readonly<Record<string, unknown>>): boolean {
  return json.type === 'object' && strictNode(json);
}
