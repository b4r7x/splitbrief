# SPLITBRIEF landing page

The page shows how a stronger planning tool hands self-contained Task Briefs to a smaller implementation tool. SPLITBRIEF owns validation, retry, escalation and the local evidence trail. The reviewer defaults to the planner. The illustrated run is explanatory, not a connected terminal.

## Visual language

Monochrome surfaces: #141414 page, #191919 panels, #e1e1df primary ink. Space Grotesk supplies headings, IBM Plex Mono supplies code and interface text, Departure Mono supplies canvas glyphs. Fonts are local, with their licenses.

The CLI's full ASCII wordmark is rendered as a single scaled `pre`, with an accessible link name and decorative glyphs hidden from assistive technology. Corner links stay with the first pinned scene. There is no full-width navigation bar, gradient, text shadow or floating prose.

The main CTA is the one-line `[ Get started ]` link. It has no icon, secondary label or enclosing box. Hover moves the brackets by 2 px; keyboard focus remains visible; the hit area is at least 44 px high. It opens readable installation immediately. Chapter links, direct links and back-to-top links also move directly to their destination, with no animated scrolling.

Eight ASCII ribbons drift, turn and scale behind the page, with four on narrow screens. Their reach and opacity grow as the bridge becomes a smaller mark, filling the space between scenes. A mask lowers contrast around the content. Their text is generated once; CSS transforms move the layers without adding work to the 3D point loop. The decorative layer is hidden from assistive technology and never receives pointer events.

## First scene: workflow

The composition is centered, up to 1280 px wide. Its heading shares the terminal's left edge. The terminal stays stationary throughout a native scroll interval; its document scrolls inside the work window.

Six buttons choose Plan, Brief, Build, Check, Review and Saved. Each phase explains the responsibility and shows its related artifact or validation result. Selecting a phase exposes its heading and reveals its content. Compact layouts fit each whole chapter in the terminal at once, with no extra reading scroll inside a phase.

The document's pixel position follows the native scroll target through a short, finite ease-out response. Each new target takes at most 120 ms to reach, with the first reversed target using 60 ms. Retargeting starts from the current displayed position; there is no stored velocity, overshoot or queue. The response applies to the document's pixel offset so reading holds cannot compress a strong gesture into a single visual jump. Phase labels and reveals follow the displayed document. Step clicks, layout changes, scene exit and reduced motion place it directly at its destination. Layout measurements never move the page to restore a previous chapter.

The workflow covers repository research, spec and plan; the approved self-contained brief; execution by the smaller tool; validation with retry/escalation; review; and local session files. A closed run has passed final review. An unfinished run can be continued. Copy does not promise unsupported cost savings or budget controls.

ASCII starts as a bridge and becomes the `[ / ]` mark using the same points. Its progress follows native scroll independently of the document's reading plateaus, without delayed motion. Desktop gives the mark a full-viewport interval after the terminal; compact layouts move through a short text interlude into the details.

## Second scene: details

Setup, Record and Install share one centered composition. The 3D mark sits to the left on desktop. Compact layouts center each panel in the space below the chapter navigation. The renderer confines the mark to its measured region; the faint background ribbons continue behind the page.

The scene pins on desktop and phones for four viewports: one viewport of content and three of scroll travel. Compact layouts prioritize the complete text: the 3D mark and repeated motion controls stand down, and spacing tightens only when needed. Short landscape screens place explanatory text beside the code or file inspector. Each third of the travel selects one chapter:

- First 30%: decode headings, prose and code.
- Next 55%: hold fully readable text.
- Last 15%: encode for the following chapter. Install instead stays readable through release.

The visible noise depends only on scroll progress and glyph position. Reverse scrolling restores the same state. Pausing scrolling does not produce random character changes. Original HTML is unchanged; a decorative canvas draws measured glyph positions during transitions. Reaching the readable state restores ordinary text selection. Navigation and controls do not scramble.

The `[ / ]` mark stays recognizable throughout the details scene. In Setup, its brackets open and the slash splits in two, echoing the two tools. In Record, those strokes unfold into three brief sheets with text lines. In Install, the sheets fold back into the original slash and the brackets close. The sculpture keeps a fixed orientation; its vertices change shape. The original bridge-to-mark transformation remains intact until the artwork enters the details scene.

Scroll position alone determines the shape, glyphs and lighting. The sculpture stops with the scroll gesture. Reverse scrolling restores exactly the same image. Each reading position holds a complete form; reduced motion selects that form directly. The original point density is preserved. All target coordinates are prepared once, leaving interpolation and rasterization for frames where progress or layout changes. Compact layouts place the same mark 28–76 px above the footer divider, in a 110–150 px region. It reveals as the divider enters the viewport, with opacity controlled only by scroll position; reduced motion shows it immediately on entry.

Setup shows the actual `.splitbrief/config.yaml` shape. Record explains the local files and supports keyboard-operated file tabs. Their descriptions encode before changing and decode afterward. Rapid selections apply only the latest request. Install defaults to npm, with a second tab for building from source; those tabs use the same transition. Until the first npm release, the npm tab says that the release is coming, points to the source tab and links the repository; it shows no command to copy. Only the active method determines the terminal height. Switching methods refits the centered panel and measures its text without moving the page. The shared project commands are doctor, init and start. Copy always takes the original displayed code, including during a transition. Clipboard failure leaves selectable commands and announces the fallback.

`#details`, `#roles`, `#record` and `#install` work as direct links. Chapter links seek to a fully readable panel. Its heading, text and controls remain in view together; scrolling advances to the next chapter.

## Motion and responsive behavior

One requestAnimationFrame loop drives both scenes, documentation transitions, tab transitions and ASCII at the display's frame cadence. It sleeps once the scenes settle and resumes on interaction or layout changes. It handles resize/font measurements, passive scroll reads, visibility and reduced-motion changes. Native scroll determines the artwork position and the terminal's visual target.

Scrollbars use a one-pixel rail and an outlined square thumb with two grip marks, echoing the terminal's brackets. The visible handle is 6 px thick inside a 14 px drag area; hover and dragging brighten its outline. Shared styles cover both axes on the page, documentation panes, tables and code blocks, with no arrow buttons. Browsers without scrollbar pseudo-elements use a thin, color-matched fallback; forced colors retain system contrast. Wheel, touch and keyboard scrolling remain native. The styling follows the [browser scrollbar guidance](https://developer.chrome.com/docs/css-ui/scrollbar-styling) without adding a scrolling controller.

Settled text scenes skip DOM painting until scroll, layout, selection or motion mode changes. The renderer prepares coordinate differences once, morph weights once per frame, and a glyph atlas after font or size changes. Occupied cells retain depth ordering and paint from that atlas. Point density is unchanged. Tab swaps remeasure affected text without resetting scroll.

Pause freezes the background ribbons while keeping scroll navigation and sculpture transformations usable. Reduced motion removes scrambling and continuous movement. Hidden tabs suspend rendering and CSS drift. Teardown removes event handlers, generated glyph layers, canvases and timers, including on HMR.

On narrow or short screens, the hero introduction scrolls away before the terminal pins near the top edge. Its six-step rail stays visible, marking the active step with ASCII brackets around its number. Measured content determines whether to tighten spacing and simplify terminal chrome; short landscape layouts use text columns. Reading text stays at least 12 px, and complete chapters fit without internal scrolling. Resize and orientation changes refit both scenes at the browser's current scroll position. Without JavaScript, all workflow chapters and installation instructions are ordinary HTML; enhancement-only controls are hidden.

Check desktop and phone views, both scroll directions, chapter endings, CTA/deep links, clipping, touch targets and source-code copying. Screenshots alone do not establish that the animation works; inspect actual scrolling as well.

## Documentation

The docs links in the landing header and footer open the documentation index at `docs/`. Vite renders every published user guide through one HTML template; maintainer pages stay on GitHub. Titles and navigation come from the sources. Local Markdown links become local page links; source-code links retain their GitHub destination. No article is copied into the website.

The header uses the exact landing wordmark, corner links and shared styles. Faint ribbons fill the margins, with a smaller 3D mark below the right contents column; reading progress changes its pose. All artwork uses the landing renderer, pause control and motion clock. On phones the 3D mark stands down and four background ribbons remain.

Desktop has a grouped page library, a reading column and a sticky contents column. The page filter matches titles. Below 1200px the contents move above the article; below 900px the library also collapses. Disclosure controls use `[ + ]` and `[ - ]`, with native keyboard semantics. Commands stay selectable and copyable; wide tables and diagrams scroll within their blocks. A `[ back to top ]` link follows the adjacent-page navigation and reaches the top immediately.

Page navigation retains the header and artwork, encodes the outgoing title while fading the article, then decodes the incoming title. Latest requests win. Back and Forward restore readable content and scroll position directly. Reduced motion removes the transition. Every page still works as static HTML without JavaScript. Removal instructions remain in README.md.

## SOTA rationale: terminal response

The native scroll position remains the input. Only the terminal's `transform` receives a finite response; no wheel interception, smooth page scrolling or animation dependency is involved. A 120 ms deadline gives the gesture a small amount of resistance and bounds the settling time after the final input. Absolute elapsed time keeps that deadline independent of refresh rate and delayed frames. The first reversed target gets a shorter response; a small reversal may still finish catching up before the displayed content turns around.

- Skills applied: `sota`, `clean-code`, `code-quality`, `anti-slop`, the focused `code-audit` checklist, `animation-performance-retro`, and `interaction-design`. Independent agents reviewed terminal behavior and implemented the footer adjustment.
- Skills skipped: React/Next.js, backend/security and full repository audit workflows; this change is confined to native TypeScript/CSS website motion.
- Sources consulted: [MDN animation-frame timing](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame), [Chrome scroll-driven animations](https://developer.chrome.com/docs/css-ui/scroll-driven-animations), and [Motion scroll-value composition](https://motion.dev/docs/react-use-scroll). Context7 supplied MDN native-animation guidance and [Playwright wheel semantics](https://playwright.dev/docs/api/class-mouse#mouse-wheel).
- Validation: finite completion, reversal, repeated input, 60/120/144 Hz sampling, exact immediate navigation, unchanged native scroll position, revealed text during transitions, and footer appearance. Native wheel traces and rendered mobile/desktop views supplement automated checks.
