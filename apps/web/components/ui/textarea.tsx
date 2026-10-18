'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

/**
 * Textarea with interior.dev's Inline Validation mechanics
 * (https://www.interior.dev/docs/inline-validation).
 *
 * interior.dev has no textarea component, so the native multi-line field is
 * kept and the inline-validation contract is adopted on top of it: the
 * message row is reserved at mount, the field shakes once when an error
 * arrives (never on every keystroke), and `aria-invalid` /
 * `aria-describedby` are wired so screen readers read the message once.
 *
 * The shake is skipped under `prefers-reduced-motion`; the message and the
 * border colour still arrive.
 */

const SHAKE = { duration: 0.32, ease: [0.36, 0.07, 0.19, 0.97] } as const;
const INSTANT = { duration: 0 } as const;

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Recolors the border and sets aria-invalid. */
  invalid?: boolean;
  /** Validation message rendered in the reserved row. */
  error?: string;
  /** Secondary line rendered when there is no error. */
  hint?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid = false, error, hint, id, ...props }, ref) => {
    const reduced = useReducedMotion();
    const autoId = React.useId();
    const fieldId = id ?? autoId;
    const messageId = `${autoId}-message`;

    const wasInvalid = React.useRef(invalid);
    const [shaking, setShaking] = React.useState(false);

    React.useEffect(() => {
      if (invalid && !wasInvalid.current) {
        setShaking(true);
        const timer = setTimeout(() => setShaking(false), 340);
        wasInvalid.current = invalid;
        return () => clearTimeout(timer);
      }
      wasInvalid.current = invalid;
      return undefined;
    }, [invalid]);

    const message = invalid ? (error ?? hint) : hint;
    const hasMessage = Boolean(message);

    return (
      <div className="w-full">
        <motion.div
          initial={false}
          animate={shaking && !reduced ? { x: [0, -5, 4, -3, 0] } : { x: 0 }}
          transition={shaking && !reduced ? SHAKE : INSTANT}
        >
          <textarea
            ref={ref}
            id={fieldId}
            aria-invalid={invalid || undefined}
            aria-describedby={hasMessage ? messageId : undefined}
            className={cn(
              'flex min-h-[6.75rem] w-full rounded-md border-2 border-border-strong bg-background px-[1.15rem] py-[0.85rem] text-sm font-semibold text-text-primary',
              'placeholder:font-medium placeholder:text-muted-foreground',
              'focus:border-secondary-500 focus:outline-none focus:ring-4 focus:ring-secondary-500/15',
              'disabled:cursor-not-allowed disabled:opacity-50',
              invalid &&
                'border-alert-error-text focus:border-alert-error-text focus:ring-alert-error-text/15',
              className,
            )}
            {...props}
          />
        </motion.div>

        <div className="mt-1.5 flex h-[16px] items-start">
          {hasMessage ? (
            <p
              id={messageId}
              className={cn(
                'min-w-0 flex-1 truncate text-[11.5px] leading-[16px]',
                invalid ? 'text-alert-error-text' : 'text-text-muted',
              )}
            >
              {message}
            </p>
          ) : null}
        </div>
      </div>
    );
  },
);
Textarea.displayName = 'Textarea';
