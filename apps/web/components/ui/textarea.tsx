import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Lightweight textarea primitive styled to match the marbetes maquette
 * `.form-field__input--textarea` (gap, border-radius, focus ring).
 *
 * Native <textarea> so it works in forms without additional plumbing and
 * matches the existing `<Input />` ergonomics used across the app.
 */
export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-[6.75rem] w-full rounded-md border-2 border-border-strong bg-background px-[1.15rem] py-[0.85rem] text-sm font-semibold text-text-primary',
        'placeholder:font-medium placeholder:text-muted-foreground',
        'focus:border-secondary-500 focus:outline-none focus:ring-4 focus:ring-secondary-500/15',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
