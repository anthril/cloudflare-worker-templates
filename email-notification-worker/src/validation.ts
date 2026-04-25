import type { SendRequest, TemplateName } from './types';
import { isValidEmail } from './utils';

const KNOWN_TEMPLATES: TemplateName[] = ['welcome', 'password-reset', 'order-confirmation'];
const MAX_SUBJECT_LEN = 998; // RFC 5322 line length limit
const MAX_IDEMPOTENCY_KEY_LEN = 128;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateSendRequest(body: unknown): ValidationResult<SendRequest> {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const obj = body as Record<string, unknown>;

  if (!isValidEmail(obj.recipient)) {
    return { ok: false, error: 'Missing or invalid field: recipient (must be a valid email address)' };
  }

  if (typeof obj.template !== 'string' || !KNOWN_TEMPLATES.includes(obj.template as TemplateName)) {
    return {
      ok: false,
      error: `Missing or invalid field: template (must be one of ${KNOWN_TEMPLATES.join(', ')})`,
    };
  }

  if (obj.subject !== undefined) {
    if (typeof obj.subject !== 'string' || obj.subject.length === 0 || obj.subject.length > MAX_SUBJECT_LEN) {
      return { ok: false, error: `Field subject must be a non-empty string under ${MAX_SUBJECT_LEN} chars` };
    }
  }

  if (obj.templateData !== undefined) {
    if (typeof obj.templateData !== 'object' || obj.templateData === null || Array.isArray(obj.templateData)) {
      return { ok: false, error: 'Field templateData must be a plain object' };
    }
  }

  if (obj.idempotency_key !== undefined) {
    if (
      typeof obj.idempotency_key !== 'string' ||
      obj.idempotency_key.length === 0 ||
      obj.idempotency_key.length > MAX_IDEMPOTENCY_KEY_LEN
    ) {
      return {
        ok: false,
        error: `Field idempotency_key must be a non-empty string under ${MAX_IDEMPOTENCY_KEY_LEN} chars`,
      };
    }
  }

  return {
    ok: true,
    value: {
      recipient: obj.recipient as string,
      template: obj.template as TemplateName,
      templateData: (obj.templateData as Record<string, unknown>) ?? {},
      subject: obj.subject as string | undefined,
      idempotency_key: obj.idempotency_key as string | undefined,
    },
  };
}
