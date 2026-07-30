import { useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { JackBullet, type JackBulletVariant } from './jack-bullet.js';

export type PanelStripProps = Omit<ComponentPropsWithoutRef<'section'>, 'children'> & {
  readonly children: ReactNode;
  readonly legend: string;
  readonly tone?: JackBulletVariant;
};

export function PanelStrip({
  children,
  className,
  legend,
  tone = 'neutral',
  ...sectionProps
}: PanelStripProps) {
  const legendId = useId();
  const classes = className
    ? `panel-strip panel-strip--${tone} ${className}`
    : `panel-strip panel-strip--${tone}`;

  return (
    <section {...sectionProps} className={classes} aria-labelledby={legendId}>
      <header className="panel-strip__header">
        <h2 id={legendId} className="panel-strip__legend">
          <JackBullet variant={tone} />
          <span>{legend}</span>
        </h2>
        <span className="panel-strip__rule" aria-hidden="true" />
      </header>
      <div className="panel-strip__content">{children}</div>
    </section>
  );
}
