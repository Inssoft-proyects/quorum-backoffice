import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'InecConecta · Backoffice',
  description: 'Quorum suite administrative backoffice.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen bg-white text-neutral-900 antialiased">
        {children}
      </body>
    </html>
  );
}
