import { DOCS_HOME_PATH } from '../../docs-home-path.js';
import { GITHUB_REPOSITORY_URL } from '../../../shared/site-identity.js';
import { PairingMatrix } from './matrix/matrix.js';
import { Wordmark } from './wordmark.js';
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

      <div className="hero__head">
        <div className="hero__copy">
          <Wordmark className="hero__wordmark" tier="compact" />
          <h1 className="hero__headline" id="landing-headline">
            Patch <span className="hero__accent-planner">your planner</span> into{' '}
            <span className="hero__accent-implementer">your implementer</span>.
          </h1>
        </div>
        <div className="hero__aside">
          <p className="hero__sub">The Task Brief is the signal between them.</p>
          <p className="hero__meta">open source · MIT · runs in your terminal</p>
          <a className="hero__cta" href="#install">
            install from source
            <span aria-hidden="true" className="hero__cta-glyph">
              ↓
            </span>
          </a>
        </div>
      </div>

      <div className="hero__field">
        <p className="hero__field-lead">
          Six planners × six implementers. Every crossing emits a complete, schema-valid config.
        </p>
        <PairingMatrix />
      </div>
    </section>
  );
}
