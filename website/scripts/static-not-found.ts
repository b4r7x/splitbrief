import { DOCS_HOME_PATH } from '../src/docs-home-path.js';

const SCRIPT_ELEMENT = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const SCRIPT_TAG = /<script\b/i;
const LINK_ELEMENT = /<link\b[^>]*>/gi;
const REL_ATTRIBUTE = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
const H1_TAG = /<h1\b/gi;
const RECOVERY_NAV =
  /<nav\b(?=[^>]*\baria-label\s*=\s*(?:"Recovery"|'Recovery'|Recovery)(?:\s|\/?>))[^>]*>([\s\S]*?)<\/nav\s*>/i;
const ANCHOR_ELEMENT = /<a\b[^>]*>/gi;
const HREF_ATTRIBUTE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

const SEMANTIC_MARKERS = [
  { label: 'main landmark', pattern: /<main\b/i },
  {
    label: '404 heading',
    pattern: /<h1\b[^>]*>\s*No signal at this address\.\s*<\/h1>/i,
  },
] as const;

function attributeValue(match: RegExpMatchArray | null): string | undefined {
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function isModulePreload(linkElement: string): boolean {
  const rel = attributeValue(linkElement.match(REL_ATTRIBUTE));
  return rel?.split(/\s+/).some((token) => token.toLowerCase() === 'modulepreload') ?? false;
}

function removeModulePreloads(html: string): string {
  return html.replace(LINK_ELEMENT, (linkElement) =>
    isModulePreload(linkElement) ? '' : linkElement,
  );
}

function containsModulePreload(html: string): boolean {
  return [...html.matchAll(LINK_ELEMENT)].some(([linkElement]) => isModulePreload(linkElement));
}

function assertRecoveryNavigation(html: string): void {
  const navigation = html.match(RECOVERY_NAV)?.[1];
  if (navigation === undefined) {
    throw new Error('Static 404 HTML lost its recovery navigation');
  }

  const destinations = [...navigation.matchAll(ANCHOR_ELEMENT)]
    .map(([anchorElement]) => attributeValue(anchorElement.match(HREF_ATTRIBUTE)))
    .filter((href): href is string => href !== undefined);
  if (!destinations.includes('/') || !destinations.includes(DOCS_HOME_PATH)) {
    throw new Error('Static 404 HTML lost a recovery link');
  }
}

export function stripStaticNotFoundScripts(html: string): string {
  if (!SCRIPT_TAG.test(html)) {
    throw new Error('Static 404 HTML has no scripts to remove');
  }

  const strippedHtml = removeModulePreloads(html.replace(SCRIPT_ELEMENT, ''));
  if (SCRIPT_TAG.test(strippedHtml) || containsModulePreload(strippedHtml)) {
    throw new Error('Static 404 HTML still loads client JavaScript');
  }

  for (const marker of SEMANTIC_MARKERS) {
    if (!marker.pattern.test(strippedHtml)) {
      throw new Error(`Static 404 HTML lost its ${marker.label}`);
    }
  }
  if ((strippedHtml.match(H1_TAG) ?? []).length !== 1) {
    throw new Error('Static 404 HTML must contain exactly one h1');
  }
  assertRecoveryNavigation(strippedHtml);

  return strippedHtml;
}
