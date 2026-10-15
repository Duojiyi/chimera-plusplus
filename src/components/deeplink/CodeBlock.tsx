import type { ReactNode } from "react";

/**
 * Read-only text in the import dialog: a caption bar (what it is, how long,
 * when it runs) over numbered lines. The block scrolls on its own and takes
 * keyboard focus so it can be scrolled without a mouse. Line numbers are
 * drawn by CSS, so copying the code never copies them.
 */
export function CodeBlock({
  code,
  caption,
  meta,
  label,
  wrap = false,
  prose = false,
}: {
  code: string;
  caption: ReactNode;
  /** Right side of the caption bar. */
  meta?: ReactNode;
  /** Accessible name of the scrollable region. */
  label: string;
  /** Wrap long lines (data) instead of scrolling sideways (scripts). */
  wrap?: boolean;
  /** Running text such as a prompt: the UI face, wrapped, no line numbers. */
  prose?: boolean;
}) {
  const lines = code.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  return (
    <figure className="dl-code-figure">
      <figcaption className="dl-code-caption">
        <span className="dl-code-title">{caption}</span>
        {meta ? <span className="dl-code-meta">{meta}</span> : null}
      </figcaption>
      <pre
        className="dl-code"
        data-wrap={wrap || prose || undefined}
        data-prose={prose || undefined}
        tabIndex={0}
        role="region"
        aria-label={label}
      >
        <code>
          {lines.map((line, index) => (
            <span key={index} className="dl-code-line">
              {line || " "}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}
