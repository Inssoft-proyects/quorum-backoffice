'use client';

/**
 * Dropdown menu replaced by interior.dev's Dropdown
 * (https://www.interior.dev/docs/dropdown).
 *
 * No call site imports this module today: action menus in this backoffice
 * are plain buttons or dialogs. The shadcn compound surface
 * (`DropdownMenu*`) is intentionally not reimplemented — the equivalent is
 * the item-based `Dropdown`, whose active highlight travels between rows
 * with a spring and which owns listbox semantics, typeahead and Escape.
 *
 * Kept as a module so future action menus import the interior primitive
 * instead of reintroducing a Radix menu.
 */
export { Dropdown, useDropdown } from '@/components/interior/dropdown';
export type { DropdownItem, DropdownProps } from '@/components/interior/dropdown';
