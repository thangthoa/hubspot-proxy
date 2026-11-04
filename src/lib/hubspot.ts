import { READ_PROPERTIES } from './config';
import { HubSpotError } from './errors';
import { log } from './log';
import { clearHubSpotTokenCache, getHubSpotToken } from './secrets';
import type { Properties } from './validate';

export interface HubSpotContact {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}

interface ContactPage {
  results: HubSpotContact[];
  paging?: { next?: { after: string } };
}

export interface BatchCreateResult {
  status: string;
  results: HubSpotContact[];
  errors?: { status: string; category: string; message: string; context?: Record<string, string[]> }[];
}

type Method = 'GET' | 'POST' | 'PATCH';

const BASE_URL = process.env.HUBSPOT_BASE_URL ?? 'https://api.hubapi.com';
const CONTACTS_PATH = '/crm/v3/objects/contacts';
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 8000;
// Keeps the worst case (PATCH = read + write, each with retries) inside the 25 s Lambda timeout.
const MAX_RETRY_DELAY_MS = 2000;

export async function listContacts(limit: number, after?: string): Promise<ContactPage> {
  const { data } = await call<ContactPage>('GET', CONTACTS_PATH, {
    query: { limit: String(limit), after, properties: READ_PROPERTIES.join(','), archived: 'false' },
  });
  return data;
}

export async function getContact(id: string, properties: readonly string[] = READ_PROPERTIES): Promise<HubSpotContact> {
  const { data } = await call<HubSpotContact>('GET', `${CONTACTS_PATH}/${id}`, {
    query: { properties: properties.join(','), archived: 'false' },
  });
  return data;
}

export async function createContact(properties: Properties): Promise<HubSpotContact> {
  const { data } = await call<HubSpotContact>('POST', CONTACTS_PATH, { body: { properties } });
  return data;
}

/** Resolves with HTTP 201 when every contact was created, 207 when some failed. */
export async function batchCreateContacts(inputs: Properties[]): Promise<{ status: number; data: BatchCreateResult }> {
  return call<BatchCreateResult>('POST', `${CONTACTS_PATH}/batch/create`, {
    body: { inputs: inputs.map((properties) => ({ properties })) },
  });
}

export async function updateContact(id: string, properties: Properties): Promise<HubSpotContact> {
  const { data } = await call<HubSpotContact>('PATCH', `${CONTACTS_PATH}/${id}`, { body: { properties } });
  return data;
}

async function call<T>(
  method: Method,
  path: string,
  options: { query?: Record<string, string | undefined>; body?: unknown },
): Promise<{ status: number; data: T }> {
  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  // A POST that timed out or got a 5xx may still have created the contact; retrying it could duplicate data.
  const retryOnFailure = method !== 'POST';

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${await getHubSpotToken()}`, 'Content-Type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // A timeout already used REQUEST_TIMEOUT_MS; retrying it could exceed the Lambda timeout.
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      if (retryOnFailure && !timedOut && attempt < MAX_ATTEMPTS) {
        await sleep(backoff(attempt));
        continue;
      }
      throw new HubSpotError(503, { message: err instanceof Error ? err.message : 'network error' });
    }

    if (res.ok) return { status: res.status, data: (await res.json()) as T };

    const body: unknown = await res.json().catch(() => undefined);
    if (res.status === 401) {
      // The token may have been rotated since we cached it: re-read once.
      clearHubSpotTokenCache();
      if (attempt === 1) continue;
    }
    // 429 means HubSpot did not process the request, so retrying is safe for every method.
    const retryable = res.status === 429 || (res.status >= 500 && retryOnFailure);
    if (retryable && attempt < MAX_ATTEMPTS) {
      log('warn', 'HUBSPOT_RETRY', { method, path, status: res.status, attempt });
      await sleep(retryAfterMs(res) ?? backoff(attempt));
      continue;
    }
    throw new HubSpotError(res.status, body);
  }
}

function retryAfterMs(res: Response): number | undefined {
  const seconds = Number(res.headers.get('retry-after'));
  return res.headers.has('retry-after') && Number.isFinite(seconds)
    ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
    : undefined;
}

function backoff(attempt: number): number {
  return Math.min(300 * 2 ** (attempt - 1) + Math.random() * 100, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
