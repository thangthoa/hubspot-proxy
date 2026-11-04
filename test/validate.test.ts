import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/errors';
import { parseBatchInput, parseContactId, parseContactInput, parseListQuery } from '../src/lib/validate';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err.code;
    throw err;
  }
  return undefined;
}

describe('parseContactInput', () => {
  it('accepts allowed fields and trims values', () => {
    expect(parseContactInput({ properties: { email: ' a@example.com ', city: 'Hanoi' } }, 'create')).toEqual({
      email: 'a@example.com',
      city: 'Hanoi',
    });
  });

  it('rejects fields outside the write allowlist', () => {
    expect(codeOf(() => parseContactInput({ properties: { hubspot_owner_id: '1' } }, 'update'))).toBe('FIELD_NOT_ALLOWED');
  });

  it('rejects clearing a protected field', () => {
    expect(codeOf(() => parseContactInput({ properties: { email: '' } }, 'update'))).toBe('FIELD_CANNOT_BE_CLEARED');
  });

  it('allows clearing a field that is not protected', () => {
    expect(parseContactInput({ properties: { city: '' } }, 'update')).toEqual({ city: '' });
  });

  it('requires email on create but not on update', () => {
    expect(codeOf(() => parseContactInput({ properties: { city: 'Hanoi' } }, 'create'))).toBe('MISSING_FIELD');
    expect(parseContactInput({ properties: { city: 'Hanoi' } }, 'update')).toEqual({ city: 'Hanoi' });
  });

  it('rejects malformed emails, nested values and extra top-level keys', () => {
    expect(codeOf(() => parseContactInput({ properties: { email: 'not-an-email' } }, 'create'))).toBe('INVALID_VALUE');
    expect(codeOf(() => parseContactInput({ properties: { city: { x: 1 } } }, 'update'))).toBe('INVALID_VALUE');
    expect(codeOf(() => parseContactInput({ properties: { city: 'x' }, archived: true }, 'update'))).toBe('INVALID_BODY');
    expect(codeOf(() => parseContactInput({ properties: {} }, 'update'))).toBe('INVALID_BODY');
  });
});

describe('parseBatchInput', () => {
  const contact = (email: string) => ({ properties: { email } });

  it('accepts up to 100 contacts', () => {
    const inputs = Array.from({ length: 100 }, (_, i) => contact(`user${i}@example.com`));
    expect(parseBatchInput({ inputs })).toHaveLength(100);
  });

  it('rejects empty and oversized batches', () => {
    expect(codeOf(() => parseBatchInput({ inputs: [] }))).toBe('INVALID_BODY');
    const inputs = Array.from({ length: 101 }, (_, i) => contact(`user${i}@example.com`));
    expect(codeOf(() => parseBatchInput({ inputs }))).toBe('INVALID_BODY');
  });

  it('reports which item is invalid', () => {
    try {
      parseBatchInput({ inputs: [contact('a@example.com'), { properties: { city: 'Hanoi' } }] });
      expect.unreachable();
    } catch (err) {
      expect((err as ApiError).message).toMatch(/^inputs\[1\]/);
    }
  });

  it('rejects the same email twice, case-insensitively', () => {
    expect(codeOf(() => parseBatchInput({ inputs: [contact('a@example.com'), contact('A@example.com')] }))).toBe(
      'DUPLICATE_IN_BATCH',
    );
  });
});

describe('query and path parsing', () => {
  it('defaults and bounds the page size', () => {
    expect(parseListQuery(null)).toEqual({ limit: 20, after: undefined });
    expect(parseListQuery({ limit: '100', after: '12345' })).toEqual({ limit: 100, after: '12345' });
    expect(codeOf(() => parseListQuery({ limit: '101' }))).toBe('INVALID_QUERY');
    expect(codeOf(() => parseListQuery({ limit: '1.5' }))).toBe('INVALID_QUERY');
    expect(codeOf(() => parseListQuery({ after: '../x' }))).toBe('INVALID_QUERY');
  });

  it('accepts numeric contact ids only', () => {
    expect(parseContactId('123')).toBe('123');
    expect(codeOf(() => parseContactId('123/archive'))).toBe('INVALID_ID');
    expect(codeOf(() => parseContactId(undefined))).toBe('INVALID_ID');
  });
});
