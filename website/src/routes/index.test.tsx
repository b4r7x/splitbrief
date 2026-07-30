import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findCopyPolicyViolations } from '../copy-policy.js';
import { Route as RootRoute } from './__root.js';
import { landingHead, Route } from './index.js';

const INSTALL_COMMANDS = `git clone https://github.com/b4r7x/splitbrief.git
cd splitbrief
npm install
npm run build
npm link`;

function installMatchMedia(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string): MediaQueryList => {
      const events = new EventTarget();

      return {
        matches: query === '(min-width: 700px)',
        media: query,
        onchange: null,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      };
    }),
  );
}

function renderLandingPage() {
  const LandingPage = Route.options.component;
  if (!LandingPage) {
    throw new Error('Landing route component is missing');
  }

  return render(<LandingPage />);
}

function rootMetadataCopy(): string {
  const head = RootRoute.options.head;
  if (!head) {
    throw new Error('Root metadata is missing');
  }

  const headResult: unknown = Reflect.apply(head, undefined, []);
  if (!isRecord(headResult) || !Array.isArray(headResult.meta)) {
    throw new Error('Root metadata is malformed');
  }

  return headResult.meta
    .flatMap((entry) => {
      if (!isRecord(entry)) {
        return [];
      }

      return [entry.title, entry.content].filter(
        (value): value is string => typeof value === 'string',
      );
    })
    .join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('LandingPage', () => {
  beforeEach(() => {
    installMatchMedia();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('composes the complete landing rack once and in contract order', () => {
    const { container } = renderLandingPage();

    const shells = container.querySelectorAll('.landing-shell[data-theme="dark"]');
    expect(shells).toHaveLength(1);

    const shell = shells[0];
    if (!(shell instanceof HTMLElement)) {
      throw new Error('Landing shell is missing');
    }

    expect(within(shell).getAllByRole('main')).toHaveLength(1);
    const main = within(shell).getByRole('main');

    const breath = container.querySelector('.breath');
    if (!(breath instanceof HTMLElement)) {
      throw new Error('Breath section is missing');
    }

    expect([...main.children]).toEqual([
      screen.getByRole('region', { name: 'Patch your planner into your implementer.' }),
      breath,
      screen.getByRole('region', { name: 'The signal' }),
      screen.getByRole('region', { name: 'Runner kinds' }),
      screen.getByRole('region', { name: 'The console' }),
      screen.getByRole('region', { name: 'The interlock' }),
      screen.getByRole('region', { name: 'Modes' }),
      screen.getByRole('region', { name: 'Install' }),
    ]);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('navigation', { name: 'Primary' })).toHaveLength(1);
    expect(screen.getAllByRole('figure', { name: 'from source — not yet on npm' })).toHaveLength(1);

    expect(within(shell).getAllByRole('contentinfo')).toHaveLength(1);
    expect(main).not.toContainElement(within(shell).getByRole('contentinfo'));
  });

  it('keeps the landing cost whisper, install artifact, and copy gate singular', () => {
    const { container } = renderLandingPage();

    expect(screen.getAllByText('You pay for the thinking once.')).toHaveLength(1);

    const installArtifacts = [...container.querySelectorAll('code')].filter(
      (code) => code.textContent === INSTALL_COMMANDS,
    );
    expect(installArtifacts).toHaveLength(1);

    const metadataCopy = rootMetadataCopy();
    expect(metadataCopy).toContain('SPLITBRIEF');
    expect(metadataCopy).toContain('reviewable Task Brief');

    const publicCopy = [container.textContent ?? '', metadataCopy].join(' ');
    expect(findCopyPolicyViolations(publicCopy)).toEqual([]);
  });

  it('emits canonical social metadata and source-backed structured data', () => {
    const head = landingHead('https://splitbrief.example');

    expect(head.links).toContainEqual({
      rel: 'canonical',
      href: 'https://splitbrief.example/',
    });
    expect(head.meta).toContainEqual({
      property: 'og:image',
      content: 'https://splitbrief.example/og.png',
    });
    expect(head.scripts).toHaveLength(1);
    expect(JSON.parse(head.scripts?.[0]?.children ?? '')).toMatchObject({
      '@type': 'SoftwareApplication',
      name: 'SPLITBRIEF',
      softwareVersion: '0.1.0',
      license: 'https://opensource.org/license/mit',
      operatingSystem: 'macOS, Linux',
      applicationCategory: 'DeveloperApplication',
      downloadUrl: 'https://github.com/b4r7x/splitbrief',
    });
  });
});
