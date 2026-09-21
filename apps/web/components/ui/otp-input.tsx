'use client';
import {
  useRef,
  useEffect,
  type KeyboardEvent,
  type ClipboardEvent,
  type ChangeEvent,
} from 'react';
import { cn } from '@/lib/utils';

/**
 * Six-digit (configurable) OTP / one-time-code input.
 *
 * Renders `length` single-character text boxes. Controlled via a single
 * concatenated digit string in `value`. Auto-advances on type, Backspace
 * moves to the previous empty box, ArrowLeft / ArrowRight navigate, and
 * a multi-digit paste fills the boxes in order.
 *
 * Used by marbete delete (WU8a); will be reused by create/edit (WU8b) and
 * dispositivos dialogs (WU9).
 */
interface OtpInputProps {
  /** Number of digits. Defaults to 6. */
  length?: number;
  /** Controlled value as a concatenated digit string. */
  value: string;
  /** Called with the new concatenated value after any change. */
  onChange: (value: string) => void;
  /** Disables all inputs. */
  disabled?: boolean;
  /** Auto-focus the first box on mount. Defaults to true. */
  autoFocus?: boolean;
  /** Group-level aria-label for the digit group. */
  'aria-label'?: string;
}

export function OtpInput({
  length = 6,
  value,
  onChange,
  disabled,
  autoFocus = true,
  'aria-label': ariaLabel = 'OTP code',
}: OtpInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = value.padEnd(length, ' ').split('').slice(0, length);

  useEffect(() => {
    if (autoFocus && refs.current[0]) {
      refs.current[0].focus();
    }
  }, [autoFocus]);

  function setDigit(index: number, ch: string) {
    const arr = digits.slice();
    arr[index] = ch || ' ';
    const joined = arr.join('').trimEnd();
    onChange(joined);
    if (ch && index < length - 1) {
      refs.current[index + 1]?.focus();
    }
  }

  function handleChange(index: number, e: ChangeEvent<HTMLInputElement>) {
    const v = e.target.value.replace(/\D/g, '').slice(-1);
    setDigit(index, v);
  }

  function handleKey(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[index]?.trim() && index > 0) {
      e.preventDefault();
      refs.current[index - 1]?.focus();
      setDigit(index - 1, '');
    } else if (e.key === 'ArrowLeft' && index > 0) {
      refs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < length - 1) {
      refs.current[index + 1]?.focus();
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (pasted) {
      onChange(pasted);
      const next = Math.min(pasted.length, length - 1);
      refs.current[next]?.focus();
    }
  }

  return (
    <div className="flex gap-2" role="group" aria-label={ariaLabel}>
      {Array.from({ length }).map((_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={digits[i]?.trim() || ''}
          onChange={(e) => handleChange(i, e)}
          onKeyDown={(e) => handleKey(i, e)}
          onPaste={handlePaste}
          disabled={disabled}
          aria-label={`Digit ${i + 1} of ${length}`}
          className={cn(
            'h-12 w-10 rounded-md border border-input bg-background text-center text-lg font-mono',
            'focus:outline-none focus:ring-2 focus:ring-primary-500',
            'disabled:opacity-50',
          )}
        />
      ))}
    </div>
  );
}
