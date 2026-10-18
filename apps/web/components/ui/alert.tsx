'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { useCollapsibleBanner } from '@/components/interior/collapsible-banner';

/**
 * Alert built on interior.dev's Collapsible Banner
 * (https://www.interior.dev/docs/collapsible-banner).
 *
 * The banner's contract is kept: it folds to its title instead of
 * disappearing, its height animates and can be interrupted mid-flight, and
 * a dismissal is announced through a polite live region. What changed is the
 * API: this repository's 16 call sites write
 * `<Alert variant="destructive" role="alert">{error}</Alert>`, so the plain
 * form renders the message in the body with no fold control, and the
 * collapsible form is opt-in through `title` + `collapsible`.
 *
 * Under `prefers-reduced-motion` the folded state still hides the body and
 * the dismissal still announces; only the height trip is skipped.
 */

const alertVariants = cva(
  'relative w-full rounded-lg border text-sm [&>svg+div]:translate-y-[-3px]',
  {
    variants: {
      variant: {
        default: 'bg-background text-text-primary border-border',
        destructive: 'border-alert-error-text/40 bg-alert-error-bg text-alert-error-text',
        warning: 'border-alert-warning-text/40 bg-alert-warning-bg text-alert-warning-text',
        success: 'border-feedback-success/40 bg-feedback-success/10 text-success-text',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface AlertProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>, VariantProps<typeof alertVariants> {
  /** Banner headline. Supplying it makes the alert foldable. */
  title?: React.ReactNode;
  /** Folds the body behind the title row. Defaults to true when `title` is set. */
  collapsible?: boolean;
  /** Shows the dismiss control. Off by default so existing call sites keep their content. */
  dismissible?: boolean;
  onDismiss?: () => void;
  defaultOpen?: boolean;
  icon?: React.ReactNode;
}

const LIFT = { type: 'spring', stiffness: 520, damping: 34, mass: 0.45 } as const;
const INSTANT = { duration: 0 } as const;

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  (
    {
      className,
      variant,
      title,
      collapsible,
      dismissible = false,
      onDismiss,
      defaultOpen = true,
      icon,
      children,
      ...props
    },
    ref,
  ) => {
    const reduced = useReducedMotion();
    const { open, dismissed, toggle, dismiss } = useCollapsibleBanner({
      defaultState: defaultOpen ? 'open' : 'folded',
      onDismiss,
    });
    const foldable = collapsible ?? Boolean(title);

    return (
      <div ref={ref} className="w-full">
        <motion.div
          initial={false}
          animate={{ height: dismissed ? 0 : 'auto', opacity: dismissed ? 0 : 1 }}
          transition={reduced ? INSTANT : { height: LIFT, opacity: { duration: 0.14 } }}
          style={{ overflow: 'hidden' }}
        >
          <div
            role="alert"
            data-variant={variant ?? 'default'}
            className={cn(alertVariants({ variant }), 'p-4', className)}
            {...props}
          >
            <div className="flex items-start gap-2.5">
              {icon ? (
                <span aria-hidden className="mt-0.5 shrink-0">
                  {icon}
                </span>
              ) : null}
              <div className="min-w-0 flex-1">
                {title ? (
                  foldable ? (
                    <button
                      type="button"
                      onClick={toggle}
                      aria-expanded={open}
                      className="flex w-full items-center justify-between gap-2 rounded-sm text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="min-w-0 flex-1">{title}</span>
                      <motion.span
                        aria-hidden
                        initial={false}
                        animate={{ rotate: open ? 180 : 0 }}
                        transition={reduced ? INSTANT : LIFT}
                        className="shrink-0"
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                          <path
                            d="M3 4.5 6 7.5 9 4.5"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </motion.span>
                    </button>
                  ) : (
                    <div className="font-medium">{title}</div>
                  )
                ) : null}

                <motion.div
                  initial={false}
                  animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
                  transition={reduced ? INSTANT : LIFT}
                  style={{ overflow: 'hidden' }}
                >
                  <div className={cn(title ? 'mt-1' : undefined)}>{children}</div>
                </motion.div>
              </div>

              {dismissible ? (
                <button
                  type="button"
                  onClick={dismiss}
                  aria-label="Descartar aviso"
                  className="grid size-6 shrink-0 place-items-center rounded-sm opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                    <path
                      d="M3 3l6 6M9 3l-6 6"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              ) : null}
            </div>
          </div>
        </motion.div>
        <span role="status" aria-live="polite" className="sr-only">
          {dismissed ? 'Aviso descartado.' : ''}
        </span>
      </div>
    );
  },
);
Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5
      ref={ref}
      className={cn('mb-1 font-medium leading-none tracking-tight', className)}
      {...props}
    />
  ),
);
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('text-sm [&_p]:leading-relaxed', className)} {...props} />
));
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
