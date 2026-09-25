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
 * Six-character (configurable) OTP / one-time-code input.
 *
 * Renders `length` single-character text boxes. Controlled via a single
 * concatenated digit string in `value`. Auto-advances on type, Backspace
 * moves to the previous empty box, ArrowLeft / ArrowRight navigate, and
 * a multi-character paste fills the boxes in order.
 *
 * Default `mode='numeric'` (digits only, `inputMode="numeric"`) preserves
 * the byte-for-byte behaviour used by the marbetes (create/edit/delete) and
 * dispositivos (create/edit/revoke) dialogs, plus the inventory bulk-upload
 * confirmation. `mode='alphanumeric'` is used by the BackOffice login
 * (`/login`) where the OTP is a 6-character uppercase A–Z0–9 code; in that
 * mode the component forces uppercase, accepts only `A–Z0–9`, exposes
 * `inputMode="text"` and `autoComplete="one-time-code"` so password
 * managers / OS autofill can offer the value.
 *
 * Used by marbete delete (WU8a); reused by create/edit (WU8b), dispositivos
 * dialogs (WU9), inventory bulk-upload, and BackOffice login OTP.
 */
export type OtpInputMode = 'numeric' | 'alphanumeric';

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
  /**
   * Character alphabet:
   * - `'numeric'` (default): digits only, `inputMode="numeric"`. Wire payload
   *   stays a digit string; matches the existing dialog call sites.
   * - `'alphanumeric'`: uppercase `A–Z` + `0–9`, forced to uppercase,
   *   `inputMode="text"`, `autoComplete="one-time-code"` on the first box.
   *   Used by the BackOffice login OTP.
   */
  mode?: OtpInputMode;
  /**
   * Optional id applied to the FIRST box only. Useful when a parent
   * `<Label htmlFor="…">` needs to associate with the group; clicking
   * the label focuses the first box, and downstream keyboard typing
   * auto-advances through the remaining boxes. Defaults to no id.
   */
  id?: string;
  /** Group-level aria-label for the digit group. */
  'aria-label'?: string;
  /** Optional testid forwarded to the group wrapper for Testing Library. */
  'data-testid'?: string;
}

const NUMERIC_FILTER = /\D/g;
const ALPHA_FILTER = /[^A-Z0-9]/g;

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
}: OtpInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const isAlpha = mode === 'alphanumeric';
  const filter = isAlpha ? ALPHA_FILTER : NUMERIC_FILTER;
  const inputMode: 'numeric' | 'text' = isAlpha ? 'text' : 'numeric';
  const chars = value.padEnd(length, ' ').split('').slice(0, length);

  useEffect(() => {
    if (autoFocus && refs.current[0]) {
      refs.current[0].focus();
    }
  }, [autoFocus]);

  function setChar(index: number, ch: string) {
    const arr = chars.slice();
    arr[index] = ch || ' ';
    const joined = arr.join('').trimEnd();
    onChange(joined);
    if (ch && index < length - 1) {
      refs.current[index + 1]?.focus();
    }
  }

  function normalise(raw: string): string {
    // In alphanumeric mode we want to accept *any* case letter and force
    // uppercase. Uppercase first so the `[^A-Z0-9]` filter does not
    // silently drop lowercase input before we have a chance to convert it.
    let next = isAlpha ? raw.toUpperCase() : raw;
    next = next.replace(filter, '');
    return next;
  }

  function handleChange(index: number, e: ChangeEvent<HTMLInputElement>) {
    const v = normalise(e.target.value).slice(-1);
    setChar(index, v);
  }

  function handleKey(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !chars[index]?.trim() && index > 0) {
      e.preventDefault();
      refs.current[index - 1]?.focus();
      setChar(index - 1, '');
    } else if (e.key === 'ArrowLeft' && index > 0) {
      refs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < length - 1) {
      refs.current[index + 1]?.focus();
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const pasted = normalise(e.clipboardData.getData('text')).slice(0, length);
    if (pasted) {
      onChange(pasted);
      const next = Math.min(pasted.length, length - 1);
      refs.current[next]?.focus();
    }
  }

  return (
    <div
      className="flex gap-2"
      role="group"
      aria-label={ariaLabel}
      data-testid={dataTestId}
    >
      {Array.from({ length }).map((_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="text"
          inputMode={inputMode}
          autoComplete={isAlpha && i === 0 ? 'one-time-code' : undefined}
          maxLength={1}
          value={chars[i]?.trim() || ''}
          onChange={(e) => handleChange(i, e)}
          onKeyDown={(e) => handleKey(i, e)}
          onPaste={handlePaste}
          disabled={disabled}
          aria-label={`Digit ${i + 1} of ${length}`}
          id={i === 0 ? id : undefined}
          className={cn(
            // Subtle default chrome (matches the design PNG). On focus we
            // switch the border + ring to the project gold token and add
            // a faint gold tint so the active box stands out without
            // overpowering the inactive ones.
            'h-12 w-11 rounded-md border border-input bg-background text-center text-lg font-mono uppercase',
            'focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:bg-primary-500/10',
            'disabled:opacity-50',
          )}
        />
      ))}
    </div>
  );
}
