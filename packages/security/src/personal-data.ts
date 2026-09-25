/**
 * Personal-data masking for read-only data lookups (docs/systems/ask.md).
 * Customer names, contact details and identity numbers read from a
 * database or a file are replaced before a model sees them or a record
 * stores them. Masking is by key (a column or JSON property that names
 * personal data) and by value (anything that looks like an email address or
 * a phone number, wherever it appears).
 */

export const MASK = '[personal]';

/** Keys whose values are personal data, whatever the value looks like. */
const PERSONAL_KEY =
  /(?:^|[_\-\s.])(?:e-?mail|phone|mobile|tel|telephone|whatsapp|address|street|zip|postcode|postal_?code|first_?name|last_?name|full_?name|given_?name|family_?name|surname|customer_?name|client_?name|contact_?name|birth|dob|national_?id|cin|passport|iban|card|card_?number|pan|ssn|ip_?address)(?:$|[_\-\s.])|^(?:name|email|phone|mobile|tel|address|ip)$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** International or local phone numbers: at least 9 digits, allowing spaces, dots, dashes and one leading +. */
const PHONE = /(?<![\w.])\+?\d(?:[\s.-]?\d){8,14}(?![\w.])/g;

export function isPersonalKey(key: string): boolean {
  return PERSONAL_KEY.test(key);
}

/** Mask email addresses and phone numbers inside free text. */
export function maskPersonalText(text: string): string {
  return text.replace(EMAIL, MASK).replace(PHONE, (match) => (isLikelyPhone(match) ? MASK : match));
}

/**
 * Ids, timestamps and amounts are long digit runs too (a GitHub run id is
 * 11 digits). A number written with a leading + or with separators is a
 * phone number; a bare run of digits is one only in a local form (a leading 0
 * and 9–10 digits, as in 0612345678) or with a country code written out
 * (00…, or 212 followed by 9 digits).
 */
function isLikelyPhone(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return false;
  if (/^\+/.test(match) || /[\s.-]/.test(match)) return !/^(?:19|20)\d{2}[\s.-]?\d{2}[\s.-]?\d{2}$/.test(match);
  return /^0\d{8,9}$/.test(digits) || /^00\d{9,13}$/.test(digits) || /^212\d{9}$/.test(digits);
}

/**
 * Deep copy of a JSON-like value with personal data masked. Keys are kept so
 * the shape stays readable ("email: [personal]"); non-personal values pass
 * through unchanged except for embedded emails and phone numbers.
 */
export function maskPersonalData<T>(value: T, depth = 0): T {
  if (depth > 32) return value;
  if (typeof value === 'string') return maskPersonalText(value) as T;
  if (Array.isArray(value)) return value.map((v) => maskPersonalData(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = v !== null && v !== undefined && typeof v !== 'object' && isPersonalKey(k) ? MASK : maskPersonalData(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
