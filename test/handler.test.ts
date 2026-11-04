import type { APIGatewayProxyEvent } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/handler';
import { recordAudit } from '../src/lib/audit';
import { clearHubSpotTokenCache } from '../src/lib/secrets';

vi.mock('../src/lib/secrets', () => ({
  getHubSpotToken: vi.fn(async () => 'pat-test-token'),
  clearHubSpotTokenCache: vi.fn(),
}));
vi.mock('../src/lib/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));

const READ = 'namy-api/contacts.read';
const WRITE = 'namy-api/contacts.write';

function event(
  method: string,
  resource: string,
  options: { scopes?: string[]; id?: string; query?: Record<string, string>; body?: unknown } = {},
): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    resource,
    path: resource.replace('{id}', options.id ?? ''),
    pathParameters: options.id ? { id: options.id } : null,
    queryStringParameters: options.query ?? null,
    body: options.body === undefined ? null : JSON.stringify(options.body),
    isBase64Encoded: false,
    requestContext: {
      requestId: 'req-1',
      authorizer: { claims: { client_id: 'partner-a', scope: (options.scopes ?? [READ, WRITE]).join(' ') } },
    },
  } as unknown as APIGatewayProxyEvent;
}

function hubspotReply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const contact = (properties: Record<string, string | null>) => ({
  id: '101',
  properties,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('access control', () => {
  it('refuses DELETE without calling HubSpot', async () => {
    const res = await handler(event('DELETE', '/contacts/{id}', { id: '101' }));
    expect(res.statusCode).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a write when the token only has the read scope', async () => {
    const res = await handler(event('POST', '/contacts', { scopes: [READ], body: { properties: { email: 'a@example.com' } } }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('INSUFFICIENT_SCOPE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a field outside the allowlist before calling HubSpot', async () => {
    const res = await handler(event('PATCH', '/contacts/{id}', { id: '101', body: { properties: { hubspot_owner_id: '9' } } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatchObject({ code: 'FIELD_NOT_ALLOWED', details: { fields: ['hubspot_owner_id'] } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /contacts', () => {
  it('returns only allowlisted properties and the next cursor', async () => {
    fetchMock.mockResolvedValueOnce(
      hubspotReply(200, {
        results: [contact({ email: 'a@example.com', hs_object_id: '101', annual_income: '999' })],
        paging: { next: { after: '202' } },
      }),
    );

    const res = await handler(event('GET', '/contacts', { scopes: [READ], query: { limit: '10' } }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      results: [{ ...contact({ email: 'a@example.com' }) }],
      paging: { nextAfter: '202' },
    });
    const url = new URL(fetchMock.mock.calls[0]![0] as URL);
    expect(url.pathname).toBe('/crm/v3/objects/contacts');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('properties')?.split(',')).toContain('email');
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer pat-test-token');
  });

  it('retries after HubSpot throttles the request', async () => {
    fetchMock
      .mockResolvedValueOnce(hubspotReply(429, { message: 'slow down' }, { 'Retry-After': '0' }))
      .mockResolvedValueOnce(hubspotReply(200, { results: [] }));

    const res = await handler(event('GET', '/contacts'));

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('HubSpot network failures', () => {
  it('does not retry a read that timed out, so the Lambda stays inside its timeout', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));

    const res = await handler(event('GET', '/contacts/{id}', { id: '101' }));

    expect(res.statusCode).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a read after a connection reset', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(hubspotReply(200, contact({ email: 'a@example.com' })));

    const res = await handler(event('GET', '/contacts/{id}', { id: '101' }));

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('PATCH /contacts/{id}', () => {
  it('records the previous values before returning the updated contact', async () => {
    fetchMock
      .mockResolvedValueOnce(hubspotReply(200, contact({ city: 'Hanoi' })))
      .mockResolvedValueOnce(hubspotReply(200, contact({ city: 'Da Nang' })));

    const res = await handler(event('PATCH', '/contacts/{id}', { id: '101', body: { properties: { city: 'Da Nang' } } }));

    expect(res.statusCode).toBe(200);
    expect(fetchMock.mock.calls[1]![1].method).toBe('PATCH');
    expect(recordAudit).toHaveBeenCalledWith([
      expect.objectContaining({
        contactId: '101',
        action: 'UPDATE',
        clientId: 'partner-a',
        changedFields: ['city'],
        before: { city: 'Hanoi' },
        after: { city: 'Da Nang' },
      }),
    ]);
  });

  it('returns 404 and changes nothing when the contact does not exist', async () => {
    fetchMock.mockResolvedValueOnce(hubspotReply(404, { message: 'not found' }));

    const res = await handler(event('PATCH', '/contacts/{id}', { id: '404', body: { properties: { city: 'Hue' } } }));

    expect(res.statusCode).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe('POST /contacts', () => {
  it('maps a duplicate email to 409', async () => {
    fetchMock.mockResolvedValueOnce(hubspotReply(409, { message: 'Contact already exists. Existing ID: 5' }));

    const res = await handler(event('POST', '/contacts', { body: { properties: { email: 'a@example.com' } } }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('CONTACT_ALREADY_EXISTS');
  });

  it('does not retry a create after a HubSpot 5xx, to avoid duplicates', async () => {
    fetchMock.mockResolvedValue(hubspotReply(500, { message: 'boom' }));

    const res = await handler(event('POST', '/contacts', { body: { properties: { email: 'a@example.com' } } }));

    expect(res.statusCode).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('hides a HubSpot auth failure behind 502 and refreshes the token', async () => {
    fetchMock.mockResolvedValue(hubspotReply(401, { message: 'expired' }));

    const res = await handler(event('GET', '/contacts/{id}', { id: '101' }));

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error.code).toBe('UPSTREAM_ERROR');
    expect(clearHubSpotTokenCache).toHaveBeenCalled();
  });
});

describe('POST /contacts/batch', () => {
  it('passes partial failures through as 207 and audits each created contact', async () => {
    fetchMock.mockResolvedValueOnce(
      hubspotReply(207, {
        status: 'COMPLETE',
        results: [contact({ email: 'a@example.com', hs_object_id: '101' })],
        errors: [{ status: 'error', category: 'VALIDATION_ERROR', message: 'Invalid phone', context: {} }],
      }),
    );

    const res = await handler(
      event('POST', '/contacts/batch', {
        body: { inputs: [{ properties: { email: 'a@example.com' } }, { properties: { email: 'b@example.com' } }] },
      }),
    );

    expect(res.statusCode).toBe(207);
    expect(JSON.parse(res.body).errors).toHaveLength(1);
    expect(recordAudit).toHaveBeenCalledWith([
      expect.objectContaining({ contactId: '101', action: 'BATCH_CREATE', after: { email: 'a@example.com' } }),
    ]);
  });
});
