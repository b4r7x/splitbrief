import { DOCS_HOME_PATH } from '../../docs-home-path.js';
import { GITHUB_REPOSITORY_URL } from '../../../shared/site-identity.js';
import { TerminalEntrance } from './terminal/terminal.js';
import './hero.css';

export function Hero() {
  return (
    <section aria-labelledby="landing-headline" className="hero">
      <div aria-hidden="true" className="hero__atmosphere">
        <div className="hero__floor" />
        <div className="hero__grain" />
      </div>

      <header className="hero__nav-row">
        <span className="hero__brand">SPLITBRIEF</span>
        <nav aria-label="Primary" className="hero__nav">
          <a href={DOCS_HOME_PATH}>[ docs ]</a>
          <a href={GITHUB_REPOSITORY_URL}>[ github ]</a>
        </nav>
      </header>

      <div className="hero__stage">
        <div className="hero__copy">
          <h1 className="hero__headline" id="landing-headline">
            Patch <span className="hero__accent-planner">any planner</span> into{' '}
            <span className="hero__accent-implementer">any implementer</span>.
          </h1>
          <p className="hero__sub">The Task Brief is the signal between them.</p>
          <p className="hero__meta">open source · MIT · runs in your terminal</p>
          <a className="hero__cta" href="#install">
            install from source
            <span aria-hidden="true" className="hero__cta-glyph">
              ↓
            </span>
          </a>
        </div>

        <div className="hero__entrance">
          <TerminalEntrance />
        </div>
      </div>
    </section>
  );
}
