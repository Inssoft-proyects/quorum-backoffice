'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Label for controls that are not a single-line text field.
 *
 * `Field` (interior.dev Floating Label) owns the label of every text input:
 * there the label is part of the control and travels with it. What remains
 * here is the semantic `<label>` for grouped controls — the OTP group, the
 * student lookup, a composite widget — where there is nothing to float.
 *
 * The Radix Label primitive is gone: `htmlFor` plus native label semantics
 * are the whole job, and browsers already forward the click and the
 * accessible name.
 */

const labelVariants = cva(
  'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
);

export interface LabelProps
  extends React.LabelHTMLAttributes<HTMLLabelElement>, VariantProps<typeof labelVariants> {}

const Label = React.forwardRef<HTMLLabelElement, LabelProps>(({ className, ...props }, ref) => (
  <label ref={ref} className={cn(labelVariants(), className)} {...props} />
));
Label.displayName = 'Label';

export { Label, labelVariants };
