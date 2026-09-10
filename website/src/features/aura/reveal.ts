export function mountReveal(sections: readonly Element[]): void {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -30% 0px', threshold: 0 },
  );
  for (const section of sections) observer.observe(section);
}
