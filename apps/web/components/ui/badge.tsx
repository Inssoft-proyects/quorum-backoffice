'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { useValueFlash } from '@/components/interior/value-flash';

/**
 * Badge with interior.dev's Value Flash
 * (https://www.interior.dev/docs/value-flash): when the badge content
 * changes — a different audit action in the drawer, a different role in the
 * topbar — the pill marks *which* value changed instead of silently
 * swapping text. `aspect-ratio`/width are untouched, so nothing around it
 * moves.
 *
 * interior.dev ships no badge, so the shape stays ours and only the
 * "a value changed here" mechanism is adopted. Non-string children opt out
 * of the comparison without losing the visual.
 *
 * Under `prefers-reduced-motion` the tint and the announcement still land;
 * only the scale pop is skipped.
 */

const badgeVariants = cva(
  'relative inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary-500 text-white',
        secondary: 'border-transparent bg-secondary-500 text-white',
        success: 'border-transparent bg-feedback-success text-white',
        destructive: 'border-transparent bg-alert-error-text text-white',
        warning: 'border-transparent bg-alert-warning-bg text-alert-warning-text',
        outline: 'text-text-primary border-border',
        muted: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

const POP = { type: 'spring', stiffness: 420, damping: 22, mass: 0.5 } as const;
const INSTANT = { duration: 0 } as const;

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, children, ...props }: BadgeProps) {
  const reduced = useReducedMotion();
  const comparable =
    typeof children === 'string' || typeof children === 'number' ? String(children) : '';

  const { flashing, direction } = useValueFlash(comparable, {
    compare: (next, previous) => (next === previous ? 0 : 1),
  });

  const tint =
    direction === 'up'
      ? 'bg-feedback-success/25'
      : direction === 'down'
        ? 'bg-alert-error-bg'
        : 'bg-transparent';

  return (
    <motion.div
      initial={false}
      animate={{ scale: flashing && !reduced ? 1.06 : 1 }}
      transition={reduced ? INSTANT : POP}
      className={cn(badgeVariants({ variant }), className)}
      {...(props as React.ComponentProps<typeof motion.div>)}
    >
      {comparable ? (
        <motion.span
          aria-hidden
          initial={false}
          animate={{ opacity: flashing ? 1 : 0 }}
          transition={reduced ? INSTANT : { duration: 0.2 }}
          className={cn('pointer-events-none absolute inset-0 rounded-full', tint)}
        />
      ) : null}
      <span className="relative">{children}</span>
      {comparable ? (
        <span className="sr-only" aria-live="polite">
          {flashing ? `${comparable}` : ''}
        </span>
      ) : null}
    </motion.div>
  );
}

export { Badge, badgeVariants };
