'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import { usePressDepth } from '@/components/interior/press-depth';

/**
 * Button built on interior.dev's *Loading Button* pattern
 * (https://www.interior.dev/docs/loading-button).
 *
 * The **Press Depth** extrusion (https://www.interior.dev/docs/press-depth)
 * was removed from the render: interior.dev ships that pattern and the flat
 * one, and the product owner rejected anything that looks 3D
 * (`odd/tasks/backoffice-ui-canon.md`, S1). So there is no underlay slab, no
 * `rotateX`/`rotateY` tilt and no `transformPerspective`; pressing only
 * travels the face 1px down on a spring, the `whileTap={{ y: 1 }}` of the
 * flat pattern. The pattern's `0 0 0 1px` ring plus `0 1px 2px` ambient
 * shadow pair is interior.dev canon and stays: flattening the press does not
 * remove it.
 *
 * The pending face is the other half of the same pattern: when
 * `loadingLabel` is supplied the idle and pending faces share one grid cell
 * from mount, so the button reserves the widest reachable width *before* it
 * gets there and the row beneath never moves. Without `loadingLabel` the
 * legacy behaviour (caller swaps the child string) is preserved untouched.
 *
 * Both mechanisms collapse to `duration: 0` under `prefers-reduced-motion`:
 * the pressed state and the pending label still arrive, only the trip is
 * skipped.
 *
 * `asChild` (Radix Slot) keeps working for link-styled triggers: Slot clones
 * a single child, so the press motion is skipped in that mode.
 */

const buttonVariants = cva(
  'relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary-500 text-white hover:bg-primary-500/90',
        destructive: 'bg-alert-error-text text-white hover:bg-alert-error-text/90',
        outline: 'border border-border bg-background hover:bg-muted hover:text-text-primary',
        secondary: 'bg-secondary-500 text-white hover:bg-secondary-500/90',
        ghost: 'hover:bg-muted hover:text-text-primary',
        link: 'text-primary-500 underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

const PRESS = { type: 'spring', stiffness: 520, damping: 34, mass: 0.45 } as const;
const CROSSFADE = { type: 'spring', stiffness: 260, damping: 34, mass: 0.8 } as const;
const INSTANT = { duration: 0 } as const;

function Spinner({ still }: { still: boolean }) {
  return (
    <motion.svg
      width="13"
      height="13"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
      animate={still ? undefined : { rotate: 360 }}
      transition={still ? undefined : { duration: 0.85, repeat: Infinity, ease: 'linear' }}
    >
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.3" />
      <path
        d="M10.5 6A4.5 4.5 0 0 0 6 1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </motion.svg>
  );
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Shows the pending face. Ignored when `asChild` is set. */
  loading?: boolean;
  /**
   * Pending-face text. Supplying it reserves the idle and pending widths
   * from mount, so toggling `loading` cannot move the row beneath.
   */
  loadingLabel?: string;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      loadingLabel,
      disabled,
      children,
      onClick,
      ...props
    },
    forwardedRef,
  ) => {
    const reduced = useReducedMotion();
    const inactive = Boolean(disabled) || loading;
    const { pressed, ref: pressRef, bind } = usePressDepth({ disabled: inactive });

    const setRef = React.useCallback(
      (node: HTMLButtonElement | null) => {
        pressRef(node);
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [pressRef, forwardedRef],
    );

    const classes = cn(buttonVariants({ variant, size, className }));

    if (asChild) {
      return (
        <Slot className={classes} ref={forwardedRef} {...props}>
          {children}
        </Slot>
      );
    }

    const move = reduced ? INSTANT : PRESS;
    const fade = reduced ? INSTANT : CROSSFADE;
    const reservesWidth = typeof loadingLabel === 'string';
    const showPending = loading && reservesWidth;

    const idleFace = (
      <motion.span
        aria-hidden={showPending || undefined}
        initial={false}
        animate={{ opacity: showPending ? 0 : 1, y: showPending ? 3 : 0 }}
        transition={fade}
        className="col-start-1 row-start-1 inline-flex items-center justify-center gap-2 whitespace-nowrap"
      >
        {children}
      </motion.span>
    );

    const pendingFace = reservesWidth ? (
      <motion.span
        aria-hidden={!loading || undefined}
        initial={false}
        animate={{ opacity: loading ? 1 : 0, y: loading ? 0 : 3 }}
        transition={fade}
        className="col-start-1 row-start-1 inline-flex items-center justify-center gap-2 whitespace-nowrap text-white/95"
      >
        <Spinner still={Boolean(reduced) || !loading} />
        {loadingLabel}
      </motion.span>
    ) : null;

    return (
      <button
        ref={setRef}
        className={classes}
        disabled={disabled}
        aria-busy={loading || undefined}
        aria-label={loading && loadingLabel ? loadingLabel : undefined}
        onClick={onClick}
        style={{
          touchAction: 'manipulation',
          WebkitTapHighlightColor: 'transparent',
        }}
        {...bind}
        {...props}
      >
        <motion.span
          initial={false}
          animate={{ y: pressed ? 1 : 0 }}
          transition={move}
          className="relative inline-grid place-items-center"
        >
          {idleFace}
          {pendingFace}
        </motion.span>
      </button>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
