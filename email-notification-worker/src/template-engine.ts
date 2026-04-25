import type { RenderedTemplate, TemplateName } from './types';
import { welcome } from './templates/welcome';
import { passwordReset } from './templates/password-reset';
import { orderConfirmation } from './templates/order-confirmation';

export type TemplateRenderer = (data: Record<string, unknown>) => RenderedTemplate;

const REGISTRY: Record<TemplateName, TemplateRenderer> = {
  'welcome': welcome,
  'password-reset': passwordReset,
  'order-confirmation': orderConfirmation,
};

/**
 * Render a template by name against caller-supplied data.
 *
 * Template renderers live in src/templates/. Each exports a pure function
 * that takes a data bag and returns {subject, html, text}. Keep them pure —
 * no network calls, no randomness — so renders are deterministic and
 * suitable for caching or diffing.
 */
export function renderTemplate(name: TemplateName, data: Record<string, unknown>): RenderedTemplate {
  const renderer = REGISTRY[name];
  if (!renderer) {
    throw new Error(`Unknown template: ${name}`);
  }
  return renderer(data ?? {});
}

/**
 * Escape a value for safe interpolation into an HTML context.
 * Templates should always pass user-supplied strings through this.
 */
export function escapeHtml(value: unknown): string {
  const str = value == null ? '' : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ALLOWED_URL_SCHEMES = /^(https?|mailto):/i;

/**
 * Validate that a value is a URL with an allowed scheme (http/https/mailto).
 * Returns the input if safe, otherwise the fallback. Defends against
 * `javascript:` and `data:` URIs even though callers are already bearer-authed.
 */
export function safeUrl(value: unknown, fallback = 'https://example.com'): string {
  if (typeof value === 'string' && ALLOWED_URL_SCHEMES.test(value)) return value;
  return fallback;
}
