import { EXPORT_BOUNDARY_RE, EXPORT_DEFAULT_NAME_RE, EXPORT_NAME_PATTERNS } from './code-patterns.js';

function isImportLine(line: string): boolean {
  return line.trimStart().startsWith('import ');
}

function isExportBoundary(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('export {')) return false;
  return EXPORT_BOUNDARY_RE.test(trimmed);
}

function extractExportName(line: string): string | null {
  const trimmed = line.trimStart();

  for (const { re } of EXPORT_NAME_PATTERNS) {
    const match = trimmed.match(re);
    if (match?.[1]) return match[1];
  }

  if (trimmed.startsWith('export default function') || trimmed.startsWith('export default class')) {
    const defaultMatch = trimmed.match(EXPORT_DEFAULT_NAME_RE);
    if (defaultMatch?.[1]) return defaultMatch[1];
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
  for (const [i, line] of lines.entries()) {
    if (isImportLine(line) || line.trim() === '') {
      if (isImportLine(line)) importEnd = i + 1;
    } else {
      break;
    }
  }
  const imports = lines.slice(0, importEnd).join('\n');

  const boundaries: { lineIndex: number; name: string | null }[] = [];
  for (const [i, line] of lines.entries()) {
    if (isExportBoundary(line)) {
      boundaries.push({ lineIndex: i, name: extractExportName(line) });
    }
  }

  if (boundaries.length === 0) return null;

  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordBoundaryRegex = new RegExp(`\\b${escaped}\\b`);
  const targetIndex = boundaries.findIndex(
    (b) => b.name !== null && wordBoundaryRegex.test(b.name),
  );

  const target = boundaries[targetIndex];
  if (targetIndex === -1 || !target) return null;

  const blockStart = target.lineIndex;
  const nextBoundary = boundaries[targetIndex + 1];
  const blockEnd = nextBoundary ? nextBoundary.lineIndex : lines.length;

  const extractStart = Math.max(0, blockStart - surroundingLines);
  const extractEnd = Math.min(lines.length, blockEnd + surroundingLines);
  const targetFunction = lines.slice(extractStart, extractEnd).join('\n');

  const otherExports = boundaries
    .filter((_, i) => i !== targetIndex)
    .map((b) => b.name)
    .filter((name): name is string => name !== null);

  return { imports, targetFunction, otherExports };
}
