/**
 * Icon wrapper for the InecConecta design system.
 *
 * WU1a scope: lucide-react named icons + variant color tokens.
 * WU1b scope: import png-x2/* from ./diseno as custom icons.
 *
 * Variants map to design tokens; never hardcode hex.
 */
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Clock,
  Grid3x3,
  IdCard,
  List,
  type LucideIcon,
  Search,
  Signal,
  User,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type IconName =
  | 'id-card'
  | 'user'
  | 'users'
  | 'search'
  | 'clock'
  | 'signal'
  | 'grid'
  | 'list'
  | 'check'
  | 'warning'
  | 'error';

export type IconVariant =
  | 'primary'
  | 'secondary'
  | 'muted'
  | 'success'
  | 'warning'
  | 'error'
  | 'inherit';

const ICON_MAP: Record<IconName, LucideIcon> = {
  'id-card': IdCard,
  user: User,
  users: Users,
  search: Search,
  clock: Clock,
  signal: Signal,
  grid: Grid3x3,
  list: List,
  check: CheckCircle2,
  warning: AlertTriangle,
  error: CircleAlert,
};

const VARIANT_CLASS: Record<IconVariant, string> = {
  primary: 'text-primary-500',
  secondary: 'text-secondary-500',
  muted: 'text-text-muted',
  success: 'text-feedback-success',
  warning: 'text-alert-warning-text',
  error: 'text-alert-error-text',
  inherit: '',
};

interface IconProps {
  name: IconName;
  variant?: IconVariant;
  size?: number;
  className?: string;
  'aria-label'?: string;
}

export function Icon({
  name,
  variant = 'inherit',
  size = 20,
  className,
  'aria-label': ariaLabel,
}: IconProps) {
  const Component = ICON_MAP[name];
  if (!Component) return null;
  return (
    <Component
      size={size}
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      className={cn(VARIANT_CLASS[variant], className)}
    />
  );
}
