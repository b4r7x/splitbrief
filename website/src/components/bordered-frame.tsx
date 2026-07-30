import { useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';

export type BorderedFrameProps = Omit<ComponentPropsWithoutRef<'figure'>, 'children'> & {
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly label: string;
  readonly meta?: ReactNode;
};

export function BorderedFrame({
  actions,
  children,
  className,
  label,
  meta,
  ...figureProps
}: BorderedFrameProps) {
  const labelId = useId();
  const classes = className ? `bordered-frame ${className}` : 'bordered-frame';

  return (
    <figure {...figureProps} className={classes} aria-labelledby={labelId}>
      <figcaption className="bordered-frame__caption">
        <span id={labelId} className="bordered-frame__label">
          {label}
        </span>
        {meta}
        <span className="bordered-frame__patch" aria-hidden="true">
          <span />
          <span />
        </span>
        {actions ? <span className="bordered-frame__actions">{actions}</span> : null}
      </figcaption>
      <div className="bordered-frame__content">{children}</div>
    </figure>
  );
}
