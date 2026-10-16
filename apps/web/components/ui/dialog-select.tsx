'use client';

import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

export interface DialogSelectOption {
  value: string;
  label: string;
}

interface DialogSelectProps {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<DialogSelectOption>;
  placeholder: string;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'data-testid'?: string;
}

export function DialogSelect({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  compact,
  className,
  ...triggerProps
}: DialogSelectProps) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((option) => option.value === value);

  return (
    <DropdownMenuPrimitive.Root modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          className={cn(
            'dialog-select__trigger custom-select__trigger',
            compact && 'dialog-select__trigger--compact',
            className,
          )}
          data-placeholder={selected ? 'false' : 'true'}
          {...triggerProps}
        >
          <span className="dialog-select__value">{selected?.label ?? placeholder}</span>
          <span className="custom-select__chevron" aria-hidden="true" />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          className="dialog-select__menu"
          sideOffset={8}
          align="start"
          collisionPadding={16}
          aria-label={triggerProps['aria-label'] ?? placeholder}
          onEscapeKeyDown={(event) => {
            // The surrounding dialog must remain open when only its menu closes.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <DropdownMenuPrimitive.RadioGroup value={value} onValueChange={onValueChange}>
            {options.map((option) => (
              <DropdownMenuPrimitive.RadioItem
                key={option.value}
                value={option.value}
                data-value={option.value}
                className="dialog-select__option"
              >
                {option.label}
              </DropdownMenuPrimitive.RadioItem>
            ))}
          </DropdownMenuPrimitive.RadioGroup>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
