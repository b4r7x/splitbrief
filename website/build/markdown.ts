import { Marked } from 'marked';
import { type Guide, guideLink } from './catalog.js';

export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

export function renderGuide(page: Guide, pages: readonly Guide[]) {
  const sections: Array<{ id: string; label: string }> = [];
  const headings = new Map<string, number>();
  let codeIndex = 0;
  let hasTitle = false;
  const parser = new Marked({
    renderer: {
      html({ text }) {
        const anchor = text.match(/^<a id="([a-z0-9_-]+)">(?:<\/a>)?\s*$/i);
        return anchor ? `<span id="${anchor[1]}"></span>` : '';
      },
      heading({ tokens, depth, text }) {
        const label = text.replace(/[`*_]/g, '');
        const slug = label
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
          .trim()
          .replace(/\s/g, '-');
        const count = headings.get(slug) ?? 0;
        headings.set(slug, count + 1);
        const id = count ? `${slug}-${count}` : slug;
        if (depth === 1 && !hasTitle) {
          hasTitle = true;
          return `<div class="docs-heading"><h1 id="${id}">${this.parser.parseInline(tokens)}</h1></div>\n`;
        }
        const level = Math.max(2, depth);
        if (level === 2) sections.push({ id, label: label.replace(/^\d+\.\s*/, '') });
        return `<h${level} id="${id}">${this.parser.parseInline(tokens)}</h${level}>\n`;
      },
      link({ href, tokens, title }) {
        const content = this.parser.parseInline(tokens);
        const target = guideLink(href, page, pages);
        if (!target) return content;
        return `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${content}</a>`;
      },
      image({ href, text }) {
        const target = guideLink(href, page, pages)?.replace(
          'https://github.com/b4r7x/splitbrief/blob/main/',
          'https://raw.githubusercontent.com/b4r7x/splitbrief/main/',
        );
        return target
          ? `<img src="${escapeHtml(target)}" alt="${escapeHtml(text)}" loading="lazy">`
          : '';
      },
      code({ text, lang }) {
        const id = `guide-${codeIndex++}`;
        const language = lang?.split(/\s/)[0] || 'text';
        const label =
          language === 'bash' || language === 'sh'
            ? 'Terminal'
            : language === 'yaml'
              ? 'Configuration / YAML'
              : language === 'text'
                ? 'Plain text'
                : language;
        return `<figure class="docs-code"><figcaption><span>${label}</span><button type="button" data-copy="${id}" aria-label="Copy ${label.toLowerCase()} block">[ copy ]</button></figcaption><pre id="${id}-command" tabindex="0"><code>${escapeHtml(text)}</code></pre></figure>\n`;
      },
    },
  });
  const article = parser
    .parse(page.markdown, { async: false })
    .replaceAll(
      '<table>',
      '<div class="docs-table" tabindex="0" role="region" aria-label="Reference table"><table>',
    )
    .replaceAll('</table>', '</table></div>');
  const contents = `<ol>${sections.map(({ id, label }) => `<li><a href="#${id}">${escapeHtml(label)}</a></li>`).join('')}</ol>`;
  return { article, contents };
}
