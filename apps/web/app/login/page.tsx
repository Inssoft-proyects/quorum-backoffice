/**
 * WU0 placeholder. WU7 implements the real login flow (form + API client +
 * session cookie).
 */
export default function LoginPagePlaceholder() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <section className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-neutral-900">
          InecConecta · Backoffice
        </h1>
        <p className="mt-4 text-sm text-neutral-600">
          Pendiente de implementar — WU7.
        </p>
        <p className="mt-2 text-xs text-neutral-500">
          Esta pantalla reemplazará el placeholder con un formulario de
          autenticación, integración con{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5">/api/v1/auth/login</code>{' '}
          y redirección al panel de Marbetes.
        </p>
      </section>
    </main>
  );
}
