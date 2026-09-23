import type { Page } from '@playwright/test';

/**
 * Accessibility helpers.
 *
 * NOTE: Playwright 1.63.0 removed `page.accessibility.snapshot()` (the
 * role-based engine was deprecated in favor of ARIA-snapshot roles). To
 * keep the audit independent of engine internals we build a small AX-like
 * tree by walking the live DOM and inferring the role + accessible name
 * for each element. The shape mirrors what `getByRole()` resolves to,
 * which is what really drives test interactions.
 *
 * For every interactive element we compute:
 *   - role       (from tagName + ARIA attributes)
 *   - name       (text content, aria-label, aria-labelledby, alt, etc.)
 *   - disabled   (from `disabled` attribute or `aria-disabled`)
 *   - focused    (we don't track this here — callers check document.activeElement)
 *
 * The walk is depth-first and stable across the small surface of the
 * backoffice product.
 */

export interface A11yNode {
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  disabled?: boolean;
  checked?: boolean | 'mixed';
  pressed?: boolean | 'mixed';
  expanded?: boolean;
  selected?: boolean;
  required?: boolean;
  level?: number;
  haspopup?: string;
  modal?: boolean;
  children?: A11yNode[];
}

const LANDMARK_ROLES: Record<string, string> = {
  header: 'banner',
  nav: 'navigation',
  main: 'main',
  aside: 'complementary',
  footer: 'contentinfo',
};

const INTERACTIVE_TAGS = new Set([
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'option',
  'optgroup',
  'summary',
  'details',
  'dialog',
  'menu',
  'menuitem',
  'tab',
  'tabpanel',
]);

/** Builds the AX-like tree for the page. */
export async function getA11yTree(page: Page): Promise<A11yNode | null> {
  return await page.evaluate(() => {
    function build(el: Element): {
      role?: string;
      name?: string;
      disabled?: boolean;
      checked?: boolean | 'mixed';
      expanded?: boolean;
      required?: boolean;
      haspopup?: string;
      modal?: boolean;
      level?: number;
      children: ReturnType<typeof build>[];
    } {
      const role = ariaRole(el as Element);
      const name = collectText(el);
      const disabled =
        (el as HTMLInputElement).disabled === true ||
        el.getAttribute('aria-disabled') === 'true';
      const ariaChecked = el.getAttribute('aria-checked');
      const checked: boolean | 'mixed' | undefined =
        ariaChecked === 'true' ? true : ariaChecked === 'mixed' ? 'mixed' : ariaChecked === 'false' ? false : undefined;
      const ariaExpanded = el.getAttribute('aria-expanded');
      const expanded =
        ariaExpanded === 'true' ? true : ariaExpanded === 'false' ? false : undefined;
      const required =
        (el as HTMLInputElement).required === true || el.getAttribute('aria-required') === 'true';
      const haspopup = el.getAttribute('aria-haspopup') ?? undefined;
      const modalAttr = el.getAttribute('aria-modal');
      const modal = modalAttr === 'true' ? true : undefined;
      let level: number | undefined;
      if (role === 'heading') {
        const match = el.tagName.match(/^H([1-6])$/);
        if (match) level = Number(match[1]);
      }
      const children: ReturnType<typeof build>[] = [];
      for (const child of Array.from(el.children)) {
        children.push(build(child));
      }
      return {
        role,
        name: name || undefined,
        disabled,
        checked,
        expanded,
        required,
        haspopup,
        modal,
        level,
        children,
      };
    }
    function ariaRole(el: Element): string | undefined {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      // Mirror the helper above so the eval block is self-contained.
      const tag = el.tagName.toLowerCase();
      const landmarks: Record<string, string> = {
        header: 'banner',
        nav: 'navigation',
        main: 'main',
        aside: 'complementary',
        footer: 'contentinfo',
      };
      if (landmarks[tag]) return landmarks[tag];
      switch (tag) {
        case 'a':
          return el.hasAttribute('href') ? 'link' : 'generic';
        case 'button':
          return 'button';
        case 'input': {
          const t = (el as HTMLInputElement).type?.toLowerCase();
          if (!t || t === 'text') return 'textbox';
          if (t === 'search') return 'searchbox';
          if (t === 'email' || t === 'url' || t === 'tel') return 'textbox';
          if (t === 'checkbox') return 'checkbox';
          if (t === 'radio') return 'radio';
          if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
          return 'textbox';
        }
        case 'select':
          return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
        case 'textarea':
          return 'textbox';
        case 'option':
          return 'option';
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          return 'heading';
        case 'img':
          return 'img';
        case 'svg':
          return 'img';
        case 'table':
          return 'table';
        case 'tr':
          return 'row';
        case 'th':
          return 'columnheader';
        case 'td':
          return 'cell';
        case 'ul':
        case 'ol':
          return 'list';
        case 'li':
          return 'listitem';
        case 'form':
          return 'form';
        case 'dialog':
          return 'dialog';
        default:
          return undefined;
      }
    }
    function collectText(el: Element): string {
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim();
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const target = document.getElementById(labelledBy);
        if (target) return (target.textContent || '').trim();
      }
      if (el.tagName === 'INPUT') {
        const input = el as HTMLInputElement;
        if (input.placeholder) return input.placeholder;
        if (input.value && input.type !== 'password') return input.value;
      }
      if (el.tagName === 'IMG') {
        const alt = (el as HTMLImageElement).alt;
        if (alt) return alt.trim();
      }
      if (el.tagName === 'svg' || el.tagName === 'SVG') {
        const title = el.querySelector('title');
        if (title?.textContent) return title.textContent.trim();
      }
      const direct = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => (n.textContent || '').trim())
        .filter(Boolean)
        .join(' ');
      if (direct) return direct;
      return (el.textContent || '').trim().slice(0, 200);
    }
    const root = document.body;
    if (!root) return null;
    return build(root) as unknown;
  }) as A11yNode | null;
}

/**
 * Depth-first walk of the a11y tree. Calls `fn(node, path)` for every
 * node. `path` is an array of role+name pairs (the breadcrumb from root
 * to the current node).
 */
export function walkTree(
  node: A11yNode | null | undefined,
  fn: (n: A11yNode, path: string[]) => void,
  path: string[] = [],
): void {
  if (!node) return;
  const here = node.name ? `${node.role ?? '?'}:${node.name}` : (node.role ?? '?');
  fn(node, [...path, here]);
  if (node.children) {
    for (const child of node.children) {
      walkTree(child, fn, [...path, here]);
    }
  }
}

/** True if the node has a non-empty accessible name. */
export function hasAccessibleName(node: A11yNode): boolean {
  return typeof node.name === 'string' && node.name.trim().length > 0;
}

/** True if the role is a layout landmark (WCAG 1.3.1). */
export function isLandmark(role: string | undefined): boolean {
  if (!role) return false;
  return [
    'banner',
    'main',
    'navigation',
    'complementary',
    'contentinfo',
    'region',
  ].includes(role);
}

/** Best-effort heuristic for focusable keyboard-reachable widgets. */
export function isFocusableKeyboard(node: A11yNode): boolean {
  if (!node.role) return false;
  if (node.disabled) return false;
  return [
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'listbox',
    'option',
    'checkbox',
    'radio',
    'switch',
  ].includes(node.role);
}

/** Tags that should appear in the tree if present. */
export { INTERACTIVE_TAGS, LANDMARK_ROLES };
