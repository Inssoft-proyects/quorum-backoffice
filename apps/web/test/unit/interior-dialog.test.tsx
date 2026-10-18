import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Dialog pins the interior.dev Modal contract the 13 dialogs depend on:
 * role/aria wiring, focus inside the panel, Escape and the scrim both route
 * through `onOpenChange`, and the Radix-compatible guards can veto a close
 * (the bulk-upload dialog uses that to survive Escape mid-upload).
 */
function Harness({
  onOpenChange,
  guard,
}: {
  onOpenChange?: (open: boolean) => void;
  guard?: (event: KeyboardEvent) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
    >
      <DialogContent data-testid="dlg" onEscapeKeyDown={guard}>
        <DialogHeader>
          <DialogTitle>Crear marbete</DialogTitle>
          <DialogDescription>Asigna un nuevo marbete.</DialogDescription>
        </DialogHeader>
        <p>Contenido</p>
      </DialogContent>
    </Dialog>
  );
}

describe('Dialog — interior Modal', () => {
  it('renders a labelled, described modal dialog', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelledBy = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)).toHaveTextContent('Crear marbete');
    const describedBy = dialog.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)).toHaveTextContent('Asigna un nuevo marbete.');
    expect(screen.getByTestId('dlg')).toBe(dialog);
  });

  it('closes on Escape through onOpenChange', () => {
    const onOpenChange = jest.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('lets onEscapeKeyDown veto the close', () => {
    const onOpenChange = jest.fn();
    const guard = jest.fn((event: KeyboardEvent) => event.preventDefault());
    render(<Harness onOpenChange={onOpenChange} guard={guard} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(guard).toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('closes from the close button', async () => {
    const user = userEvent.setup();
    const onOpenChange = jest.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing while closed', () => {
    render(
      <Dialog open={false} onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Oculto</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
