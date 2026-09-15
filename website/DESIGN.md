# SPLITBRIEF landing page

The page shows how a stronger planning tool hands self-contained Task Briefs to a smaller implementation tool. SPLITBRIEF owns validation, retry, escalation and the local evidence trail. The reviewer defaults to the planner. The illustrated run is explanatory, not a connected terminal.

## Visual language

Monochrome surfaces: #141414 page, #191919 panels, #e1e1df primary ink. Space Grotesk supplies headings, IBM Plex Mono supplies code and interface text, Departure Mono supplies canvas glyphs. Fonts are local, with their licenses.

The CLI's full ASCII wordmark is rendered as a single scaled `pre`, with an accessible link name and decorative glyphs hidden from assistive technology. Corner links stay with the first pinned scene. There is no full-width navigation bar, gradient, text shadow or floating prose.

The main CTA is the one-line `[ Get started ]` link. It has no icon, secondary label or enclosing box. Hover moves the brackets by 2 px; keyboard focus remains visible; the hit area is at least 44 px high. It reaches the fully decoded installation state.

Sparse ASCII ribbons drift behind the page from the introduction through the footer, including the space between scenes. They use the same monochrome glyph language as the bridge, with lower contrast around the content. Their text is generated once; CSS transforms move the layers without adding work to the 3D point loop. The decorative layer is hidden from assistive technology and never receives pointer events.

## First scene: workflow

The composition is centered, up to 1280 px wide. Its heading shares the terminal's left edge. The terminal stays stationary throughout a native scroll interval; its document scrolls inside the work window.

Six buttons choose Plan, Brief, Build, Check, Review and Saved. Each phase explains the responsibility and shows its related artifact or validation result. Selecting a phase exposes its heading and reveals its content. Long chapters pan within their phase, keeping their final lines reachable on phones.

Chapter movement eases into and out of its reading positions. The document's pixel position follows the scroll destination with critical damping, so wheel bursts retain continuous velocity through the short intervals between chapters. A step click uses the same motion. Phase labels and text reveals stay aligned with the visible document during travel, then advance within each reading position. Resizing and reduced motion place the document directly at its destination.

The workflow covers repository research, spec and plan; the approved self-contained brief; execution by the smaller tool; validation with retry/escalation; review; and local session files. A closed run has passed final review. An unfinished run can be continued. Copy does not promise unsupported cost savings or budget controls.

ASCII starts as a bridge and becomes the `[ / ]` mark using the same points. A full-viewport interval reveals the mark after the terminal leaves.

## Second scene: details

Setup, Record and Install share one centered composition. The 3D mark sits to the left on desktop and above the content on narrow layouts. The renderer confines that mark to its measured region; the faint background ribbons continue behind the page.

When the composition fits the viewport, the scene pins for a four-viewport track: one viewport of content and three of scroll travel. Panels share stable dimensions. Each third of the travel selects one chapter:

- First 30%: decode headings, prose and code.
- Next 55%: hold fully readable text.
- Last 15%: encode for the following chapter. Install instead stays readable through release.

The visible noise depends only on scroll progress and glyph position. Reverse scrolling restores the same state. Pausing scrolling does not produce random character changes. Original HTML is unchanged; a decorative canvas draws measured glyph positions during transitions. Reaching the readable state restores ordinary text selection. Navigation and controls do not scramble.

Setup opens the bracket parts slightly. Record separates them in depth. Install returns the compact mark. Geometry is interpolated continuously and follows the same chapter progress as text.

Setup shows the actual `.splitbrief/config.yaml` shape. Record explains the local files and supports keyboard-operated file tabs. Install provides source-install commands and the commands to run inside the user's project. Copy always takes the original displayed code, including during a transition. Clipboard failure leaves selectable commands and announces the fallback.

`#details`, `#roles`, `#record` and `#install` work as direct links. Chapter links seek to a fully readable point. No wheel or touch event is intercepted to simulate scrolling.

## Motion and responsive behavior

One requestAnimationFrame loop drives both scenes and ASCII. It handles resize/font measurements, passive scroll reads, visibility and reduced-motion changes. Geometry is measured before painting. Ambient rendering is capped near 30 fps; scroll easing uses the shared frame clock.

Settled text scenes skip DOM painting until scroll, layout, selection or motion mode changes. Fallback layouts do not measure unused decoding glyphs. The renderer prepares rotation once per frame, groups occupied cells by tone in one scan, and calculates each beam's coordinate basis once. Preserve point density, depth ordering and scroll cadence when optimizing it further.

Pause freezes both ambient time and background transforms while keeping scroll navigation usable. Reduced motion removes scrambling and continuous movement. Hidden tabs suspend rendering and CSS drift. Teardown removes event handlers, generated glyph layers, canvases and timers, including on HMR.

Below 650 px viewport height the first scene uses document flow. The second scene measures its content and uses document flow whenever it cannot fit with readable text and controls. In fallback, all three panels remain readable. Without JavaScript, all workflow chapters and installation instructions are ordinary HTML; enhancement-only controls are hidden.

Check desktop and phone views, both scroll directions, chapter endings, CTA/deep links, clipping, touch targets and source-code copying. Screenshots alone do not establish that the animation works; inspect actual scrolling as well.
