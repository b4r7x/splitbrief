import { createFileRoute } from '@tanstack/react-router';
import websitePackage from '../../package.json';
import { PanelStrip } from '../components/panel-strip.js';
import { Hero } from '../features/landing/hero.js';
import { InstallBlock, InstallCaption } from '../features/landing/install-block.js';
import { BreathSection } from '../features/landing/sections/breath.js';
import { ConsoleSection } from '../features/landing/sections/console.js';
import { InterlockSection } from '../features/landing/sections/interlock.js';
import { ModesSection } from '../features/landing/sections/modes.js';
import { PatchFieldSection } from '../features/landing/sections/patch-field.js';
import { RunnerKindsSection } from '../features/landing/sections/runner-kinds.js';
import { SignalSection } from '../features/landing/sections/signal.js';
import { SiteFooter } from '../features/landing/site-footer.js';
import '../features/landing/signal-path.css';
import { pageMetadata, SITE_ORIGIN, softwareApplicationJsonLd } from '../seo-metadata.js';
import { DEFAULT_DESCRIPTION } from '../../shared/site-identity.js';

export const Route = createFileRoute('/')({
  head: () => landingHead(),
  component: LandingPage,
});

export function landingHead(siteOrigin = SITE_ORIGIN) {
  const metadata = pageMetadata({
    description: DEFAULT_DESCRIPTION,
    path: '/',
    siteOrigin,
    title: 'SPLITBRIEF',
  });
  return {
    ...metadata,
    scripts:
      siteOrigin === ''
        ? []
        : [
            {
              type: 'application/ld+json',
              children: softwareApplicationJsonLd({
                siteOrigin,
                version: websitePackage.version,
              }),
            },
          ],
  };
}

function LandingPage() {
  return (
    <div className="landing-shell" data-theme="dark">
      <main>
        <Hero />
        <PatchFieldSection />
        <BreathSection />
        <SignalSection />
        <RunnerKindsSection />
        <ConsoleSection />
        <InterlockSection />
        <ModesSection />
        <PanelStrip className="install-strip" id="install" legend="Install">
          <InstallBlock />
          <InstallCaption />
        </PanelStrip>
      </main>
      <SiteFooter />
    </div>
  );
}
