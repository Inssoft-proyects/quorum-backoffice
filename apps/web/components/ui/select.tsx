'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Accessible native-styled select.
 *
 * The marbetes maquette (diseno/maqueta_Inec/Inec/css/credential-inventory.css)
 * shows a fully custom listbox. Since the project does not depend on
 * `@radix-ui/react-select` (deliberate: the hard constraint forbids
 * installing new packages), we render a native <select> styled to match the
 * maquette. Native <select> is keyboard- and screen-reader-friendly
 * out-of-the-box and works in jest/jsdom without further plumbing.
 */

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  options: ReadonlyArray<SelectOption>;
  placeholder?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, options, placeholder, value, defaultValue, ...props }, ref) => {
    return (
      <div className={cn('custom-select', className)}>
        <select
          ref={ref}
          className={cn(
            'custom-select__trigger',
            'appearance-none pr-10',
          )}
          value={value}
          defaultValue={defaultValue}
          data-placeholder={value === '' || value === undefined ? 'true' : 'false'}
          {...props}
        >
          {placeholder ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 h-4 w-4 text-text-muted-bold"
          aria-hidden
        />
      </div>
    );
  },
);
Select.displayName = 'Select';
