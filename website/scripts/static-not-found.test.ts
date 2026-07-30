// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { stripStaticNotFoundScripts } from './static-not-found.js';

const STATIC_NOT_FOUND_HTML = [
  '<!DOCTYPE html><html><head>',
  '<link rel="stylesheet" href="/assets/site.css"/>',
  '<link rel="modulepreload" href="/assets/app.js"/>',
  '<link rel=modulepreload href="/assets/vendor.js"/>',
  '<link rel="preload modulepreload" href="/assets/chunk.js"/>',
  '</head><body>',
  '<main><h1 id="not-found-title">No signal at this address.</h1>',
  '<nav aria-label="Recovery"><a href="/">Home</a>',
  '<a href="/docs/getting-started/introduction">Docs</a></nav></main>',
  '<script>window.__ROUTER__ = true</script>',
  '<script type="module" src="/assets/app.js"></script>',
  '</body></html>',
].join('');

describe('static 404 output', () => {
  it('removes all client JavaScript while preserving the semantic document', () => {
    const output = stripStaticNotFoundScripts(STATIC_NOT_FOUND_HTML);

    expect(output).not.toMatch(/<script\b/i);
    expect(output).not.toContain('modulepreload');
    expect(output).toContain('<link rel="stylesheet" href="/assets/site.css"/>');
    expect(output).toContain('<main>');
    expect(output).toContain('<h1 id="not-found-title">No signal at this address.</h1>');
    expect(output).toContain('<nav aria-label="Recovery">');
  });

  it('fails when the generated page has no scripts to remove', () => {
    expect(() =>
      stripStaticNotFoundScripts(
        '<main><h1>No signal at this address.</h1><nav aria-label="Recovery"><a href="/">Home</a><a href="/docs/getting-started/introduction">Docs</a></nav></main>',
      ),
    ).toThrow('Static 404 HTML has no scripts to remove');
  });

  it('refuses to transform a page without the 404 semantic contract', () => {
    expect(() =>
      stripStaticNotFoundScripts(
        '<main><h1>Home</h1><nav aria-label="Recovery"><a href="/">Home</a><a href="/docs/getting-started/introduction">Docs</a></nav></main><script></script>',
      ),
    ).toThrow('Static 404 HTML lost its 404 heading');
  });

  it('rejects duplicate primary headings', () => {
    expect(() =>
      stripStaticNotFoundScripts(
        `${STATIC_NOT_FOUND_HTML.replace('</main>', '<h1>Duplicate</h1></main>')}`,
      ),
    ).toThrow('Static 404 HTML must contain exactly one h1');
  });

  it.each(['/', '/docs/getting-started/introduction'])(
    'rejects output without the %s recovery destination',
    (destination) => {
      const anchorPattern = new RegExp(`<a href="${destination.replace('/', '\\/')}">[^<]+<\\/a>`);

      expect(() =>
        stripStaticNotFoundScripts(STATIC_NOT_FOUND_HTML.replace(anchorPattern, '')),
      ).toThrow('Static 404 HTML lost a recovery link');
    },
  );
});
