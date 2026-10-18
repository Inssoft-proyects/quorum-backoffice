'use client';

import * as React from 'react';
import {
  FloatingLabelInput,
  type FloatingLabelInputProps,
} from '@/components/interior/floating-label';

/**
 * Field — the project's form control, built on interior.dev's Floating Label
 * (https://www.interior.dev/docs/floating-label).
 *
 * Why this replaces the `<Label /> + <Input />` pair: the label now owns the
 * resting slot and raises itself into a reserved row on focus or fill, so a
 * field pre-filled from the server never animates on load, a hint or error
 * arriving on blur never pushes the submit button down the page, and the
 * character counter reserves the width of its widest string. The label
 * travels on transform only, which is what makes the spring resumable.
 *
 * Native plumbing (`data-testid`, `min`, `minLength`, `onKeyDown`, …) goes
 * through `inputProps`; `id`, `name`, `type`, `value`, `onChange` and the
 * accessibility wiring stay first-class so tests and forms read the same
 * way they did with the shadcn pair.
 */
export type FieldProps = FloatingLabelInputProps;

export function Field(props: FieldProps) {
  return <FloatingLabelInput {...props} />;
}

Field.displayName = 'Field';
