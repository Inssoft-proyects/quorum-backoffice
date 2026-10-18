'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import { useOtpInput, type OtpMode } from '@/components/interior/otp-input';

/**
 * OTP input built on interior.dev's OTP Input
 * (https://www.interior.dev/docs/otp-input): auto-advance on type, paste
 * that fills the group in one gesture, Backspace that clears the current box
 * then retreats to the previous one, arrow/Home/End navigation, a caret that
 * blinks only on the active empty cell, and a single shake when the group
 * enters the error state.
 *
 * The controlled contract is unchanged — `value` is a concatenated string and
 * `onChange` receives the next one — because 16 dialogs plus the login and
 * MFA screens already drive it that way, and the RTL suite pins the exact
 * `inputMode`, `autoComplete`, per-box `aria-label` (`Digit N of 6`), group
 * `role`/`aria-label`, first-box-only `id` and `data-testid` surface.
 *
 * `mode='numeric'` keeps the historical surface: no `autoComplete` at all.
 * `mode='alphanumeric'` forces uppercase at the input boundary and exposes
 * `autoComplete="one-time-code"` on the first box only.
 */
export type OtpInputMode = OtpMode;
export type OtpStatus = 'idle' | 'error' | 'success';

interface OtpInputProps {
  /** Number of characters. Defaults to 6. */
  length?: number;
  /** Controlled value as a concatenated character string. */
  value: string;
  /** Called with the new concatenated value after any change. */
  onChange: (value: string) => void;
  /** Disables all inputs. */
  disabled?: boolean;
  /** Auto-focus the first box on mount. Defaults to true. */
  autoFocus?: boolean;
  /** Character alphabet. */
  mode?: OtpInputMode;
  /** Optional id applied to the FIRST box only. */
  id?: string;
  /** Group-level aria-label for the digit group. */
  'aria-label'?: string;
  /** Optional testid forwarded to the group wrapper. */
  'data-testid'?: string;
  /** Marks the group as errored; triggers the single shake. */
  status?: OtpStatus;
  /** Message shown under the group while `status='error'`. */
  errorMessage?: string;
  /** Message shown under the group while `status='success'`. */
  successMessage?: string;
  /** Secondary line shown when the status is idle. */
  hint?: string;
}

const SHAKE = { duration: 0.32, ease: [0.36, 0.07, 0.19, 0.97] } as const;
const STILL = { duration: 0 } as const;

export function OtpInput({
  length = 6,
  value,
  onChange,
  disabled,
  autoFocus = true,
  mode = 'numeric',
  id,
  'aria-label': ariaLabel = 'OTP code',
  'data-testid': dataTestId,
  status = 'idle',
  errorMessage,
  successMessage,
  hint,
}: OtpInputProps) {
  const reduced = useReducedMotion();
  const isAlpha = mode === 'alphanumeric';

  const { chars, focusedIndex, getCellProps, focusAt } = useOtpInput({
    length,
    mode,
    value,
    disabled: Boolean(disabled),
    normalize: isAlpha ? (raw) => raw.toUpperCase() : undefined,
    jumpToFirstEmpty: false,
    onChange,
  });

  React.useEffect(() => {
    if (autoFocus && !disabled) focusAt(0);
  }, [autoFocus, disabled, focusAt]);

  const wasError = React.useRef(status === 'error');
  const [shaking, setShaking] = React.useState(false);
  React.useEffect(() => {
    const error = status === 'error';
    if (error && !wasError.current) {
      setShaking(true);
      const timer = setTimeout(() => setShaking(false), 340);
      wasError.current = error;
      return () => clearTimeout(timer);
    }
    wasError.current = error;
    return undefined;
  }, [status]);

  const message = status === 'error' ? errorMessage : status === 'success' ? successMessage : hint;
  const hasMessage = Boolean(message);
  const messageId = React.useId();

  return (
    <div className="inline-flex flex-col">
      <motion.div
        role="group"
        aria-label={ariaLabel}
        data-testid={dataTestId}
        initial={false}
        animate={shaking && !reduced ? { x: [0, -5, 4, -3, 0] } : { x: 0 }}
        transition={shaking && !reduced ? SHAKE : STILL}
        className="flex gap-2"
      >
        {Array.from({ length }).map((_, i) => {
          const active = focusedIndex === i;
          const char = chars[i] ?? '';
          const cell = getCellProps(i);
          return (
            <div key={i} className="relative h-12 w-11">
              <input
                {...cell}
                autoComplete={isAlpha ? (i === 0 ? 'one-time-code' : undefined) : undefined}
                maxLength={1}
                id={i === 0 ? id : undefined}
                aria-label={`Digit ${i + 1} of ${length}`}
                aria-invalid={status === 'error' || undefined}
                aria-describedby={hasMessage ? messageId : undefined}
                className={cn(
                  'h-12 w-11 rounded-md border border-input bg-background text-center text-lg font-mono uppercase caret-transparent',
                  'focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:bg-primary-500/10',
                  'disabled:opacity-50',
                  status === 'error' && 'border-alert-error-text',
                  status === 'success' && 'border-feedback-success',
                )}
              />
              {active && !char && !disabled ? (
                <motion.span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 grid place-items-center"
                  initial={{ opacity: 1 }}
                  animate={reduced ? { opacity: 1 } : { opacity: [1, 1, 0, 0] }}
                  transition={
                    reduced
                      ? STILL
                      : {
                          duration: 1.06,
                          times: [0, 0.5, 0.5, 1],
                          repeat: Infinity,
                          ease: 'linear',
                        }
                  }
                >
                  <span className="block h-[18px] w-[1.5px] rounded-[1px] bg-primary-500" />
                </motion.span>
              ) : null}
            </div>
          );
        })}
      </motion.div>

      {hasMessage ? (
        <>
          <motion.div
            aria-hidden
            key={status}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduced ? STILL : { duration: 0.2 }}
            className={cn(
              'mt-2 h-4 text-[11.5px] leading-[16px]',
              status === 'error'
                ? 'text-alert-error-text'
                : status === 'success'
                  ? 'text-success-text'
                  : 'text-text-muted',
            )}
          >
            {message}
          </motion.div>
          <span id={messageId} role="status" className="sr-only">
            {message}
          </span>
        </>
      ) : null}
    </div>
  );
}
