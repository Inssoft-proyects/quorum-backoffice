'use client';

import * as React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDropdown } from '@/components/interior/dropdown';

/**
 * Select built on interior.dev's Dropdown
 * (https://www.interior.dev/docs/dropdown): the active highlight travels
 * between rows with a spring, the list opens with a scale/translate that
 * resumes mid-flight, and the whole list is a real listbox with typeahead,
 * Home/End, arrows and Escape handled by the upstream hook.
 *
 * The public API stays the one call sites already use — `options`, `value`,
 * `onChange(event)` with `event.target.value`, `placeholder`, `id` — because
 * the pagination passes a native-select-shaped handler. The trigger keeps the
 * `.custom-select__trigger` class so the maquette chrome still applies, and
 * `data-placeholder` is preserved.
 */

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  options: ReadonlyArray<SelectOption>;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  name?: string;
  'aria-label'?: string;
  'data-testid'?: string;
  onChange?: (event: { target: { value: string; name?: string } }) => void;
}

const NUDGE = { type: 'spring', stiffness: 520, damping: 30, mass: 0.5 } as const;
const OPEN = { type: 'spring', stiffness: 520, damping: 36, mass: 0.7 } as const;
const STILL = { duration: 0 } as const;

export const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      options,
      value,
      defaultValue,
      placeholder,
      disabled = false,
      className,
      id,
      name,
      'aria-label': ariaLabel,
      'data-testid': dataTestId,
      onChange,
    },
    forwardedRef,
  ) => {
    const reduced = useReducedMotion();
    const items = React.useMemo(
      () => options.map((option) => ({ value: option.value, label: option.label })),
      [options],
    );

    const { open, activeIndex, selectedItem, rootRef, triggerProps, listProps, getItemProps } =
      useDropdown({
        items,
        value,
        defaultValue,
        disabled,
        onChange: (next) => onChange?.({ target: { value: next, name } }),
      });

    const isEmpty = (value ?? defaultValue ?? '') === '';
    const currentLabel = selectedItem?.label ?? placeholder ?? '';

    return (
      <div ref={rootRef} className={cn('custom-select relative', className)}>
        <button
          {...triggerProps}
          ref={(node) => {
            triggerProps.ref.current = node;
            if (typeof forwardedRef === 'function') forwardedRef(node);
            else if (forwardedRef) forwardedRef.current = node;
          }}
          id={id}
          name={name}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          data-placeholder={isEmpty ? 'true' : 'false'}
          data-testid={dataTestId}
          className="custom-select__trigger flex w-full items-center justify-between gap-2 text-left outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className={cn('truncate', isEmpty && 'text-text-muted')}>{currentLabel}</span>
          <motion.span
            aria-hidden
            initial={false}
            animate={{ rotate: open ? 180 : 0 }}
            transition={reduced ? STILL : NUDGE}
            className="shrink-0 text-text-muted-bold"
          >
            <ChevronDown className="h-4 w-4" />
          </motion.span>
        </button>

        <AnimatePresence>
          {open ? (
            <motion.div
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={
                reduced
                  ? { opacity: 0 }
                  : { opacity: 0, scale: 0.98, y: -4, transition: { duration: 0.12 } }
              }
              transition={reduced ? STILL : { ...OPEN, opacity: { duration: 0.12 } }}
              style={{ transformOrigin: 'top left' }}
              className="absolute left-0 top-[calc(100%+6px)] z-50 min-w-full whitespace-nowrap rounded-lg border border-border bg-popover p-[4px] shadow-lg"
            >
              <ul
                {...listProps}
                aria-label={ariaLabel ?? 'Opciones'}
                className="relative max-h-[216px] overflow-y-auto outline-none"
              >
                <motion.span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 top-0 h-8 rounded-sm bg-muted"
                  initial={false}
                  animate={{
                    y: activeIndex < 0 ? 0 : activeIndex * 32,
                    opacity: activeIndex < 0 ? 0 : 1,
                  }}
                  transition={reduced ? STILL : NUDGE}
                />
                {items.map((item, index) => (
                  <li
                    key={item.value}
                    {...getItemProps(index)}
                    className="relative flex h-8 cursor-default select-none items-center rounded-sm px-2.5 text-sm text-text-primary"
                  >
                    <span className="truncate">{item.label}</span>
                  </li>
                ))}
              </ul>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    );
  },
);
Select.displayName = 'Select';
