const EXPORT_BOUNDARY_PREFIXES = [
  'export function ',
  'export async function ',
  'export const ',
  'export interface ',
  'export type ',
  'export class ',
  'export default function',
  'export default class',
];

function isImportLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('import ');
}

function isExportBoundary(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('export {')) return false;
  return EXPORT_BOUNDARY_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function extractExportName(line: string): string | null {
  const trimmed = line.trimStart();

  const funcMatch = trimmed.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
  if (funcMatch) return funcMatch[1];

  const constMatch = trimmed.match(/^export\s+const\s+(\w+)/);
  if (constMatch) return constMatch[1];

  const interfaceMatch = trimmed.match(/^export\s+interface\s+(\w+)/);
  if (interfaceMatch) return interfaceMatch[1];

  const typeMatch = trimmed.match(/^export\s+type\s+(\w+)/);
  if (typeMatch) return typeMatch[1];

  const classMatch = trimmed.match(/^export\s+class\s+(\w+)/);
  if (classMatch) return classMatch[1];

  if (trimmed.startsWith('export default function') || trimmed.startsWith('export default class')) {
    const defaultMatch = trimmed.match(/^export\s+default\s+(?:function|class)\s+(\w+)/);
    if (defaultMatch) return defaultMatch[1];
    return 'default';
  }

  return null;
}

export function extractFunctionContext(
  fileContent: string,
  functionName: string,
  surroundingLines: number = 5,
): { imports: string; targetFunction: string; otherExports: string[] } | null {
  const lines = fileContent.split('\n');

  let importEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    if (isImportLine(lines[i]) || lines[i].trim() === '') {
      if (isImportLine(lines[i])) importEnd = i + 1;
    } else {
      break;
    }
  }
  const imports = lines.slice(0, importEnd).join('\n');

  const boundaries: { lineIndex: number; name: string | null }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isExportBoundary(lines[i])) {
      boundaries.push({ lineIndex: i, name: extractExportName(lines[i]) });
    }
  }

  if (boundaries.length === 0) return null;

  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordBoundaryRegex = new RegExp(`\\b${escaped}\\b`);
  const targetIndex = boundaries.findIndex(
    (b) => b.name !== null && wordBoundaryRegex.test(b.name),
  );

  if (targetIndex === -1) return null;

  const target = boundaries[targetIndex];
  const blockStart = target.lineIndex;
  const blockEnd =
    targetIndex + 1 < boundaries.length ? boundaries[targetIndex + 1].lineIndex : lines.length;

  const extractStart = Math.max(0, blockStart - surroundingLines);
  const extractEnd = Math.min(lines.length, blockEnd + surroundingLines);
  const targetFunction = lines.slice(extractStart, extractEnd).join('\n');

  const otherExports = boundaries
    .filter((_, i) => i !== targetIndex)
    .map((b) => b.name)
    .filter((name): name is string => name !== null);

  return { imports, targetFunction, otherExports };
}
