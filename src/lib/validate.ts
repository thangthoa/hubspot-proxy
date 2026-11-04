import { CREATE_REQUIRED_PROPERTIES, LIMITS, NON_CLEARABLE_PROPERTIES, WRITE_PROPERTIES } from './config';
import { ApiError } from './errors';

export type Properties = Record<string, string>;
type Mode = 'create' | 'update';

const writable = new Set<string>(WRITE_PROPERTIES);
const nonClearable = new Set<string>(NON_CLEARABLE_PROPERTIES);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_ID = /^\d{1,20}$/;
const PAGING_CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

export function parseJsonBody(raw: string | null, isBase64Encoded: boolean): unknown {
  if (!raw) throw new ApiError(400, 'INVALID_BODY', 'Request body is required.');
  const text = isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'INVALID_BODY', 'Request body must be valid JSON.');
  }
}

export function parseContactId(id: string | undefined): string {
  if (!id || !CONTACT_ID.test(id)) throw new ApiError(400, 'INVALID_ID', 'Contact id must be numeric.');
  return id;
}

export function parseListQuery(query: Record<string, string | undefined> | null): { limit: number; after?: string } {
  const after = query?.after;
  if (after !== undefined && !PAGING_CURSOR.test(after)) {
    throw new ApiError(400, 'INVALID_QUERY', 'after is not a valid paging cursor.');
  }
  if (query?.limit === undefined) return { limit: LIMITS.listDefault, after };

  const limit = Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.listMax) {
    throw new ApiError(400, 'INVALID_QUERY', `limit must be an integer between 1 and ${LIMITS.listMax}.`);
  }
  return { limit, after };
}

/** Validates a `{"properties": {...}}` body against the write policy. */
export function parseContactInput(body: unknown, mode: Mode): Properties {
  if (!isObject(body) || !isObject(body.properties) || Object.keys(body).some((key) => key !== 'properties')) {
    throw new ApiError(400, 'INVALID_BODY', 'Body must be {"properties": {...}}.');
  }
  return parseProperties(body.properties, mode);
}

/** Validates a `{"inputs": [{"properties": {...}}, ...]}` batch-create body. */
export function parseBatchInput(body: unknown): Properties[] {
  if (!isObject(body) || !Array.isArray(body.inputs) || Object.keys(body).some((key) => key !== 'inputs')) {
    throw new ApiError(400, 'INVALID_BODY', 'Body must be {"inputs": [{"properties": {...}}]}.');
  }
  if (body.inputs.length < 1 || body.inputs.length > LIMITS.batchMax) {
    throw new ApiError(400, 'INVALID_BODY', `inputs must contain 1 to ${LIMITS.batchMax} contacts.`);
  }

  const contacts = body.inputs.map((item, index) => withIndex(index, () => parseContactInput(item, 'create')));
  const emails = contacts.map((properties) => properties.email?.toLowerCase());
  const duplicates = [...new Set(emails.filter((email, i) => email && emails.indexOf(email) !== i))];
  if (duplicates.length > 0) {
    throw new ApiError(400, 'DUPLICATE_IN_BATCH', 'The same email appears more than once in inputs.', {
      indexes: emails.flatMap((email, i) => (email && duplicates.includes(email) ? [i] : [])),
    });
  }
  return contacts;
}

function parseProperties(input: Record<string, unknown>, mode: Mode): Properties {
  const entries = Object.entries(input);
  if (entries.length === 0) throw new ApiError(400, 'INVALID_BODY', 'properties must not be empty.');

  const notAllowed = entries.map(([key]) => key).filter((key) => !writable.has(key));
  if (notAllowed.length > 0) {
    throw new ApiError(400, 'FIELD_NOT_ALLOWED', 'Some fields cannot be written.', { fields: notAllowed });
  }

  const properties: Properties = {};
  for (const [key, value] of entries) {
    properties[key] = parseValue(key, value);
  }

  if (mode === 'create') {
    const missing = CREATE_REQUIRED_PROPERTIES.filter((key) => !properties[key]);
    if (missing.length > 0) {
      throw new ApiError(400, 'MISSING_FIELD', 'Required fields are missing.', { fields: missing });
    }
  }
  return properties;
}

function parseValue(key: string, value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new ApiError(400, 'INVALID_VALUE', `${key} must be a string, number or boolean.`);
  }
  const text = String(value).trim();
  if (text.length > LIMITS.valueMaxLength) {
    throw new ApiError(400, 'INVALID_VALUE', `${key} must be at most ${LIMITS.valueMaxLength} characters.`);
  }
  if (text === '' && nonClearable.has(key)) {
    throw new ApiError(400, 'FIELD_CANNOT_BE_CLEARED', `${key} cannot be empty.`);
  }
  if (key === 'email' && text !== '' && !EMAIL.test(text)) {
    throw new ApiError(400, 'INVALID_VALUE', 'email is not a valid email address.');
  }
  return text;
}

function withIndex<T>(index: number, parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof ApiError) throw new ApiError(err.status, err.code, `inputs[${index}]: ${err.message}`, err.details);
    throw err;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
