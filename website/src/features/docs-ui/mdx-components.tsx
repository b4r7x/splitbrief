import { useHydrated } from '@tanstack/react-router';
import type { MDXComponents } from 'mdx/types';
import { useId, useRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { BorderedFrame } from '../../components/bordered-frame.js';
import { type CopyFeedbackState, useCopyFeedback } from '../../hooks/use-copy-feedback.js';
import './mdx-content.css';

const COPY_LABELS = {
  copied: 'Code copied',
  failed: 'Copy failed; retry',
  idle: 'Copy code',
} as const satisfies Record<CopyFeedbackState, string>;

const COPY_TEXT = {
  copied: '[ copied ]',
  failed: '[ retry ]',
  idle: '[ copy ]',
} as const satisfies Record<CopyFeedbackState, string>;

export interface CalloutProps {
  readonly children: ReactNode;
  readonly title: string;
}

type MdxPreProps = ComponentPropsWithoutRef<'pre'> & {
  readonly icon?: string;
};

function MdxWrapper({ children }: { readonly children: ReactNode }) {
  return <div className="docs-prose">{children}</div>;
}

function MdxHeading2({ children, id, ...headingProps }: ComponentPropsWithoutRef<'h2'>) {
  return (
    <h2 {...headingProps} id={id}>
      {id ? (
        <a className="docs-heading__anchor" href={`#${id}`}>
          <span>{children}</span>
          <span aria-hidden="true">#</span>
        </a>
      ) : (
        children
      )}
    </h2>
  );
}

function MdxHeading3({ children, id, ...headingProps }: ComponentPropsWithoutRef<'h3'>) {
  return (
    <h3 {...headingProps} id={id}>
      {id ? (
        <a className="docs-heading__anchor" href={`#${id}`}>
          <span>{children}</span>
          <span aria-hidden="true">#</span>
        </a>
      ) : (
        children
      )}
    </h3>
  );
}

function MdxPre({ children, className, icon: _icon, ...preProps }: MdxPreProps) {
  const hydrated = useHydrated();
  const { copyState, copyText } = useCopyFeedback();
  const preRef = useRef<HTMLPreElement>(null);

  return (
    <BorderedFrame
      actions={
        <button
          aria-label={COPY_LABELS[copyState]}
          className="docs-code-frame__copy"
          disabled={!hydrated}
          onClick={() => void copyText(preRef.current?.textContent)}
          type="button"
        >
          {COPY_TEXT[copyState]}
        </button>
      }
      className="docs-code-frame"
      label="Code"
    >
      <pre {...preProps} className={className} ref={preRef}>
        {children}
      </pre>
    </BorderedFrame>
  );
}

function MdxTable({ children, ...tableProps }: ComponentPropsWithoutRef<'table'>) {
  const labelId = useId();

  return (
    // biome-ignore lint/a11y/useSemanticElements: A fieldset is not semantic for tabular data.
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to reach horizontally scrollable tables.
    <div aria-labelledby={labelId} className="docs-table-scroll" role="group" tabIndex={0}>
      <span className="docs-visually-hidden" id={labelId}>
        Scrollable data table
      </span>
      <table {...tableProps}>{children}</table>
    </div>
  );
}

export function Callout({ children, title }: CalloutProps) {
  const titleId = useId();

  return (
    <aside aria-labelledby={titleId} className="docs-callout">
      <p className="docs-callout__title" id={titleId}>
        {title}
      </p>
      <div className="docs-callout__body">{children}</div>
    </aside>
  );
}

export const mdxComponents = {
  Callout,
  a: (props) => <a {...props} className="docs-link" />,
  blockquote: (props) => <blockquote {...props} className="docs-blockquote" />,
  h2: MdxHeading2,
  h3: MdxHeading3,
  pre: MdxPre,
  table: MdxTable,
  wrapper: MdxWrapper,
} satisfies MDXComponents;
