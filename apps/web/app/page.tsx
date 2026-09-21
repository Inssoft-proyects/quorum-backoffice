import { redirect } from 'next/navigation';

/**
 * Root `/` redirects to `/dashboard`. The (authed) layout is what
 * actually enforces the session — an unauthed visitor gets bounced to
 * /login by the layout's getServerSession/redirect.
 */
export default function HomePage(): never {
  redirect('/dashboard');
}