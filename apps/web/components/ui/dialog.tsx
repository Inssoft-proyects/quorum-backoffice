'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useModal } from '@/components/interior/modal';

/**
 * Dialog built on interior.dev's Modal
 * (https://www.interior.dev/docs/modal).
 *
 * The behaviour is upstream: scroll lock, a Tab/Shift+Tab focus trap, Escape
 * and scrim dismissal, `inert` siblings, `role="dialog"` + `aria-modal`, and
 * a panel that enters from its origin and can be reversed mid-flight. What
 * this file keeps is the compound API this repository already consumes
 * (`Dialog` + `DialogContent`/`Header`/`Title`/`Description`/`Footer`), so
 * the 13 dialog call sites did not need rewriting. The three Radix-compatible
 * outside/escape guards (`onEscapeKeyDown`, `onPointerDownOutside`,
 * `onInteractOutside`) are honoured because the bulk-upload dialog uses them
 * to refuse closing mid-upload.
 *
 * The Radix implementation is gone; `DialogTrigger`, `DialogClose`,
 * `DialogPortal` and `DialogOverlay` remain as thin compatibility wrappers.
 *
 * Under `prefers-reduced-motion` the backdrop and panel still appear, only
 * the trip is skipped.
 */

const SURFACE = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const;
const EASE = [0.16, 1, 0.3, 1] as const;
const INSTANT = { duration: 0 } as const;

type OverlayProps = ReturnType<typeof useModal>['overlayProps'];
type PanelProps = ReturnType<typeof useModal>['panelProps'];

type DialogContextValue = {
  open: boolean;
  setOpen: (next: boolean) => void;
  titleId: string;
  descriptionId: string;
  target: HTMLElement | null;
  overlayProps: OverlayProps;
  panelProps: PanelProps;
  describedBy: string | null;
  registerDescription: (id: string | null) => void;
};

const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialogContext(): DialogContextValue {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error('Dialog components must be used inside <Dialog>');
  return ctx;
}

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
  defaultOpen?: boolean;
}

function Dialog({ open, onOpenChange, children, defaultOpen = false }: DialogProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
  const isControlled = open !== undefined;
  const resolved = isControlled ? Boolean(open) : uncontrolled;
  const [describedBy, setDescribedBy] = React.useState<string | null>(null);

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  const modal = useModal({
    open: resolved,
    onClose: () => setOpen(false),
  });

  const value = React.useMemo<DialogContextValue>(
    () => ({
      open: resolved,
      setOpen,
      titleId: modal.titleId,
      descriptionId: modal.descriptionId,
      target: modal.target,
      overlayProps: modal.overlayProps,
      panelProps: modal.panelProps,
      describedBy,
      registerDescription: setDescribedBy,
    }),
    [resolved, setOpen, modal, describedBy],
  );

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}

const DialogTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }
>(({ asChild = false, onClick, children, ...props }, ref) => {
  const ctx = useDialogContext();

  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<{ onClick?: (e: React.MouseEvent) => void }>;
    return React.cloneElement(child, {
      onClick: (event: React.MouseEvent) => {
        child.props.onClick?.(event);
        if (!event.defaultPrevented) ctx.setOpen(true);
      },
    });
  }

  return (
    <button
      ref={ref}
      type="button"
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) ctx.setOpen(true);
      }}
      {...props}
    >
      {children}
    </button>
  );
});
DialogTrigger.displayName = 'DialogTrigger';

const DialogClose = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }
>(({ asChild = false, onClick, children, ...props }, ref) => {
  const ctx = useDialogContext();

  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<{ onClick?: (e: React.MouseEvent) => void }>;
    return React.cloneElement(child, {
      onClick: (event: React.MouseEvent) => {
        child.props.onClick?.(event);
        if (!event.defaultPrevented) ctx.setOpen(false);
      },
    });
  }

  return (
    <button
      ref={ref}
      type="button"
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) ctx.setOpen(false);
      }}
      {...props}
    >
      {children}
    </button>
  );
});
DialogClose.displayName = 'DialogClose';

const DialogPortal = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

const DialogOverlay = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      aria-hidden
      className={cn('fixed inset-0 z-50 bg-black/60 backdrop-blur-sm', className)}
      {...props}
    />
  ),
);
DialogOverlay.displayName = 'DialogOverlay';

export interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Radix-compatible guard, honoured before the dialog closes. */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  /** Radix-compatible guard, honoured before the dialog closes. */
  onPointerDownOutside?: (event: Event) => void;
  /** Radix-compatible guard, honoured before the dialog closes. */
  onInteractOutside?: (event: Event) => void;
}

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  (
    { className, children, onEscapeKeyDown, onPointerDownOutside, onInteractOutside, ...props },
    forwardedRef,
  ) => {
    const ctx = useDialogContext();
    const reduced = useReducedMotion();
    const { open, target, overlayProps, panelProps, describedBy } = ctx;

    React.useEffect(() => {
      if (!open || !onEscapeKeyDown) return;
      const handler = (event: KeyboardEvent) => {
        onEscapeKeyDown(event);
        if (event.defaultPrevented) event.stopPropagation();
      };
      document.addEventListener('keydown', handler, true);
      return () => document.removeEventListener('keydown', handler, true);
    }, [open, onEscapeKeyDown]);

    const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
      const native = event.nativeEvent;
      onInteractOutside?.(native);
      onPointerDownOutside?.(native);
      if (native.defaultPrevented) return;
      overlayProps.onClick(event);
    };

    const attachPanel = React.useCallback(
      (node: HTMLDivElement | null) => {
        panelProps.ref.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [panelProps.ref, forwardedRef],
    );

    if (!target) return null;

    const backdrop = reduced
      ? {
          closed: { opacity: 0 },
          open: { opacity: 1, transition: { duration: 0 } },
          gone: { opacity: 0, transition: { duration: 0 } },
        }
      : {
          closed: { opacity: 0 },
          open: { opacity: 1, transition: { duration: 0.2, ease: EASE } },
          gone: { opacity: 0, transition: { duration: 0.15, ease: EASE } },
        };

    const panel = reduced
      ? {
          closed: { opacity: 0 },
          open: { opacity: 1, transition: { duration: 0 } },
          gone: { opacity: 0, transition: { duration: 0 } },
        }
      : {
          closed: { opacity: 0, scale: 0.96, y: 12 },
          open: {
            opacity: 1,
            scale: 1,
            y: 0,
            transition: { ...SURFACE, opacity: { duration: 0.16, ease: EASE } },
          },
          gone: {
            opacity: 0,
            scale: 0.98,
            y: 6,
            transition: { duration: 0.15, ease: EASE },
          },
        };

    return createPortal(
      <AnimatePresence>
        {open ? (
          <motion.div
            key="dialog"
            ref={overlayProps.ref}
            onPointerDown={overlayProps.onPointerDown}
            onClick={handleOverlayClick}
            initial="closed"
            animate="open"
            exit="gone"
            variants={{ closed: {}, open: {}, gone: {} }}
            className="fixed inset-0 z-50 grid place-items-center p-4 sm:p-6"
          >
            <motion.div
              aria-hidden="true"
              variants={backdrop}
              style={{ touchAction: 'none' }}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              ref={attachPanel}
              role={panelProps.role}
              aria-modal={panelProps['aria-modal']}
              aria-labelledby={panelProps['aria-labelledby']}
              aria-describedby={describedBy ?? undefined}
              tabIndex={panelProps.tabIndex}
              onKeyDown={panelProps.onKeyDown}
              variants={panel}
              className={cn(
                'relative flex max-h-[min(88vh,760px)] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-background p-6 shadow-lg',
                className,
              )}
              {...(props as React.ComponentProps<typeof motion.div>)}
            >
              {children}
              <button
                type="button"
                onClick={() => ctx.setOpen(false)}
                className="absolute right-4 top-4 grid size-7 place-items-center rounded-sm opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-4 w-4" aria-hidden />
                <span className="sr-only">Cerrar</span>
              </button>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>,
      target,
    );
  },
);
DialogContent.displayName = 'DialogContent';

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1.5 pr-8 text-left', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, id, ...props }, ref) => {
    const ctx = React.useContext(DialogContext);
    return (
      <h2
        ref={ref}
        id={id ?? ctx?.titleId}
        className={cn('text-lg font-semibold leading-none tracking-tight', className)}
        {...props}
      />
    );
  },
);
DialogTitle.displayName = 'DialogTitle';

const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, id, ...props }, ref) => {
  const ctx = React.useContext(DialogContext);
  const resolvedId = id ?? ctx?.descriptionId;

  React.useEffect(() => {
    if (!ctx || !resolvedId) return;
    ctx.registerDescription(resolvedId);
    return () => ctx.registerDescription(null);
  }, [ctx, resolvedId]);

  return (
    <div
      ref={ref}
      id={resolvedId}
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
});
DialogDescription.displayName = 'DialogDescription';

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
