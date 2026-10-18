'use client';

/**
 * Tabs replaced by interior.dev's Tabs
 * (https://www.interior.dev/docs/tabs).
 *
 * The equivalent is item-based: one shared indicator plate slides between
 * tabs with a `layout` spring, the label inverts as the plate passes under
 * it, and the panel height animates. The shadcn/Radix compound surface
 * (`Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`) had no consumers, so it is
 * not reimplemented; callers pass `items` and render a panel with
 * `renderPanel`.
 */
export { Tabs, useTabs } from '@/components/interior/tabs';
export type { TabItem, TabsActivation, TabsProps, UseTabsReturn } from '@/components/interior/tabs';
