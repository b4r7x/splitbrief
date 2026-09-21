type Chapter = { top: number; height: number };
type Anchor = { progress: number; offset: number };

export const phases = [
  { id: 'plan', name: 'Plan', start: 0, end: 0.12, caption: '01 / Your request becomes a plan.' },
  {
    id: 'brief',
    name: 'Brief',
    start: 0.18,
    end: 0.31,
    caption: '02 / You approve the handoff before execution.',
  },
  {
    id: 'build',
    name: 'Build',
    start: 0.36,
    end: 0.48,
    caption: '03 / The smaller tool works from one brief.',
  },
  {
    id: 'check',
    name: 'Check',
    start: 0.53,
    end: 0.68,
    caption: '04 / Validate. Retry. Escalate when needed.',
  },
  {
    id: 'review',
    name: 'Review',
    start: 0.74,
    end: 0.84,
    caption: '05 / The stronger tool reviews the finished work.',
  },
  {
    id: 'saved',
    name: 'Saved',
    start: 0.89,
    end: 1,
    caption: '06 / The brief, checks and review stay on disk.',
  },
];

export function createTimeline(
  chapters: readonly Chapter[],
  viewHeight: number,
  totalHeight: number,
) {
  const travel = Math.max(0, totalHeight - viewHeight);
  const anchors: Anchor[] = phases.flatMap((phase, index) => {
    const chapter = chapters[index];
    if (!chapter) throw new Error(`Missing workflow chapter: ${phase.id}`);
    return [
      { progress: phase.start, offset: Math.min(chapter.top, travel) },
      {
        progress: phase.end,
        offset: Math.min(chapter.top + Math.max(0, chapter.height - viewHeight), travel),
      },
    ];
  });

  function offset(progress: number) {
    let previous = { progress: 0, offset: 0 };
    for (const anchor of anchors) {
      if (progress <= anchor.progress) {
        const distance = anchor.progress - previous.progress;
        const amount = distance ? Math.max(0, (progress - previous.progress) / distance) : 0;
        return previous.offset + (anchor.offset - previous.offset) * amount;
      }
      previous = anchor;
    }
    return previous.offset;
  }

  function phaseAt(progress: number) {
    let current = 0;
    for (const [index, phase] of phases.entries()) {
      const previous = phases[index - 1];
      const threshold = previous ? (previous.end + phase.start) / 2 : 0;
      if (progress >= threshold) current = index;
    }
    return current;
  }

  function progressAtOffset(position: number, preferred: number) {
    if (Math.abs(offset(preferred) - position) < 0.01) return preferred;
    let previous = { progress: 0, offset: 0 };
    for (const anchor of anchors) {
      const distance = anchor.offset - previous.offset;
      if (position <= anchor.offset && distance > 0) {
        const amount = Math.max(0, (position - previous.offset) / distance);
        return previous.progress + (anchor.progress - previous.progress) * amount;
      }
      previous = anchor;
    }
    return previous.progress;
  }

  return { offset, phaseAt, progressAtOffset };
}
