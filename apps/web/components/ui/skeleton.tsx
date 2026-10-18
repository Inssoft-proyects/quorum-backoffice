'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { SkeletonSwap } from '@/components/interior/skeleton-swap';

/**
 * Skeleton replaced by interior.dev's Skeleton Swap
 * (https://www.interior.dev/docs/skeleton-swap).
 *
 * The old primitive was an `animate-pulse` div. The equivalent guarantee is
 * different and stronger: the placeholder and the resolved content occupy
 * the *same box*, so when the data lands nothing under it moves. `Skeleton`
 * remains as the static block for callers that only need the chrome, and
 * `SkeletonSwap` is the component to use when content is arriving.
 */

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div aria-hidden className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />
  );
}

export { Skeleton, SkeletonSwap };
