import * as React from "react";

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Rendered width; defaults to the container width. */
  width?: number | string;
  /** Rendered height in pixels. */
  height?: number;
  /** Corner radius; match the block the placeholder stands in for. */
  radius?: number;
}

/**
 * Loading placeholder for content that is already known to be coming.
 *
 * The bar has no text: a skeleton says "this region is loading", nothing more.
 * The wrapping element carries the accessible label so a screen reader hears
 * one status message instead of a row of meaningless boxes.
 */
export function Skeleton({
  width,
  height = 12,
  radius = 8,
  className,
  style,
  ...rest
}: SkeletonProps) {
  return (
    <div
      className={className ? `skeleton ${className}` : "skeleton"}
      aria-hidden="true"
      style={{ width, height, borderRadius: radius, ...style }}
      {...rest}
    />
  );
}

export interface SkeletonStackProps extends React.HTMLAttributes<HTMLDivElement> {
  /** How many bars to draw. */
  rows?: number;
  /** Accessible description of what is loading. */
  label: string;
}

/** A stack of skeleton bars, announced once as a polite status. */
export function SkeletonStack({
  rows = 3,
  label,
  className,
  ...rest
}: SkeletonStackProps) {
  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      aria-label={label}
      {...rest}
    >
      <span className="sr-only">{label}</span>
      <div style={{ display: "grid", gap: 8 }}>
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} height={index === 0 ? 14 : 10} />
        ))}
      </div>
    </div>
  );
}
