// A section's three groups take 2 × 120 ms + 420 ms (reveal.css); a section that becomes visible
// while the previous one is still entering waits for it, so two sections sharing a fold enter in
// reading order instead of at once. A section is being read only while its head is on screen: one
// scrolled past its head (an anchor landing below it, a smooth scroll through it) enters at once
// and holds nothing back.
const CHOREOGRAPHY = 660;

function readFromItsHead(section: Element | undefined): boolean {
  return section !== undefined && section.getBoundingClientRect().top >= 0;
}

export function mountReveal(sections: readonly Element[]): void {
  let last = 0;
  let pending: Element | undefined;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        if (entry.boundingClientRect.top < 0) {
          entry.target.classList.add('is-in');
          continue;
        }
        const wait = readFromItsHead(pending) ? last + CHOREOGRAPHY - performance.now() : 0;
        last = performance.now() + Math.max(0, wait);
        pending = entry.target;
        if (wait <= 0) entry.target.classList.add('is-in');
        else setTimeout(() => entry.target.classList.add('is-in'), wait);
      }
    },
    { rootMargin: '0px 0px -30% 0px', threshold: 0 },
  );
  for (const section of sections) observer.observe(section);
}
