'use client';

/**
 * Table sorting replaced by interior.dev's Sortable Table
 * (https://www.interior.dev/docs/sortable-table).
 *
 * The equivalent guarantees that a re-sort does not blink: rows are FLIP
 * animated to their new order (spring, interruptible), the header announces
 * `aria-sort`, and rows can be marked. The shadcn table chrome
 * (`Table`/`TableHeader`/`TableRow`/…) had no consumers — the inventory
 * screens render their own maquette tables — so this module now exports the
 * interior component plus its sorting hook.
 */
export { SortableTable, useSortableRows } from '@/components/interior/sortable-table';
export type {
  OrderedRow,
  SortDirection,
  SortState,
  SortableColumn,
  SortableTableProps,
} from '@/components/interior/sortable-table';
