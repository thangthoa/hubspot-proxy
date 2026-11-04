import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { recordAudit, type AuditEntry } from './lib/audit';
import { READ_PROPERTIES, SCOPES, WRITE_PROPERTIES } from './lib/config';
import { ApiError, errorMessage, fromHubSpotError, HubSpotError } from './lib/errors';
import {
  batchCreateContacts,
  createContact,
  getContact,
  listContacts,
  updateContact,
  type HubSpotContact,
} from './lib/hubspot';
import { log } from './lib/log';
import { parseBatchInput, parseContactId, parseContactInput, parseJsonBody, parseListQuery } from './lib/validate';

interface RequestContext {
  event: APIGatewayProxyEvent;
  clientId: string;
  requestId: string;
}

interface RouteResult {
  status: number;
  body: unknown;
}

interface Route {
  scope: keyof typeof SCOPES;
  run: (ctx: RequestContext) => Promise<RouteResult>;
}

/**
 * The complete list of operations partners can perform.
 * There is deliberately no delete, archive or merge route.
 */
const ROUTES: Record<string, Route> = {
  'GET /contacts': { scope: 'read', run: listRoute },
  'GET /contacts/{id}': { scope: 'read', run: getRoute },
  'POST /contacts': { scope: 'write', run: createRoute },
  'POST /contacts/batch': { scope: 'write', run: batchCreateRoute },
  'PATCH /contacts/{id}': { scope: 'write', run: updateRoute },
};

const readable = new Set<string>(READ_PROPERTIES);
const writable = new Set<string>(WRITE_PROPERTIES);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const startedAt = Date.now();
  const requestId = event.requestContext?.requestId ?? 'unknown';
  const routeKey = `${event.httpMethod} ${event.resource}`;
  const claims = (event.requestContext?.authorizer?.claims ?? {}) as Record<string, unknown>;
  const clientId = typeof claims.client_id === 'string' ? claims.client_id : 'unknown';

  try {
    const route = ROUTES[routeKey];
    if (!route) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'This operation is not supported.');
    // API Gateway already checks scopes; repeated here so a misconfigured method can never widen access.
    assertScope(claims.scope, SCOPES[route.scope]);

    const result = await route.run({ event, clientId, requestId });
    log('info', 'REQUEST', { route: routeKey, clientId, status: result.status, ms: Date.now() - startedAt, requestId });
    return respond(result.status, result.body, requestId);
  } catch (err) {
    const apiError = toApiError(err);
    log(apiError.status >= 500 ? 'error' : 'warn', 'REQUEST_FAILED', {
      route: routeKey,
      clientId,
      status: apiError.status,
      code: apiError.code,
      ms: Date.now() - startedAt,
      requestId,
      ...(apiError.status >= 500 && { cause: errorMessage(err) }),
    });
    const { status, code, message, details } = apiError;
    return respond(status, { error: { code, message, details, requestId } }, requestId);
  }
}

async function listRoute({ event }: RequestContext): Promise<RouteResult> {
  const { limit, after } = parseListQuery(event.queryStringParameters);
  const page = await listContacts(limit, after);
  return {
    status: 200,
    body: { results: page.results.map(toPublicContact), paging: { nextAfter: page.paging?.next?.after ?? null } },
  };
}

async function getRoute({ event }: RequestContext): Promise<RouteResult> {
  const contact = await getContact(parseContactId(event.pathParameters?.id));
  return { status: 200, body: toPublicContact(contact) };
}

async function createRoute({ event, clientId, requestId }: RequestContext): Promise<RouteResult> {
  const properties = parseContactInput(parseJsonBody(event.body, event.isBase64Encoded), 'create');
  const created = await createContact(properties);
  await recordAudit([
    { contactId: created.id, action: 'CREATE', clientId, requestId, changedFields: Object.keys(properties), after: properties },
  ]);
  return { status: 201, body: toPublicContact(created) };
}

async function batchCreateRoute({ event, clientId, requestId }: RequestContext): Promise<RouteResult> {
  const inputs = parseBatchInput(parseJsonBody(event.body, event.isBase64Encoded));
  const { status, data } = await batchCreateContacts(inputs);
  await recordAudit(
    data.results.map((contact): AuditEntry => {
      const after = pick(contact.properties, (key) => writable.has(key));
      return { contactId: contact.id, action: 'BATCH_CREATE', clientId, requestId, changedFields: Object.keys(after), after };
    }),
  );
  return {
    status: status === 207 ? 207 : 201,
    body: {
      results: data.results.map(toPublicContact),
      errors: (data.errors ?? []).map(({ message, category, context }) => ({ message, category, context })),
    },
  };
}

async function updateRoute({ event, clientId, requestId }: RequestContext): Promise<RouteResult> {
  const id = parseContactId(event.pathParameters?.id);
  const properties = parseContactInput(parseJsonBody(event.body, event.isBase64Encoded), 'update');
  const changedFields = Object.keys(properties);

  // Read current values first so the audit record can restore them if the partner writes bad data.
  const current = await getContact(id, changedFields);
  const updated = await updateContact(id, properties);
  await recordAudit([
    {
      contactId: id,
      action: 'UPDATE',
      clientId,
      requestId,
      changedFields,
      before: pick(current.properties, (key) => key in properties),
      after: properties,
    },
  ]);
  return { status: 200, body: toPublicContact(updated) };
}

function assertScope(scopeClaim: unknown, required: string): void {
  const granted = typeof scopeClaim === 'string' ? scopeClaim.split(' ') : [];
  if (!granted.includes(required)) {
    throw new ApiError(403, 'INSUFFICIENT_SCOPE', `This operation requires the ${required} scope.`);
  }
}

function toPublicContact(contact: HubSpotContact) {
  return {
    id: contact.id,
    properties: pick(contact.properties, (key) => readable.has(key)),
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  };
}

function pick(properties: Record<string, string | null> | undefined, keep: (key: string) => boolean) {
  return Object.fromEntries(Object.entries(properties ?? {}).filter(([key]) => keep(key)));
}

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof HubSpotError) return fromHubSpotError(err);
  return new ApiError(500, 'INTERNAL_ERROR', 'Unexpected error. Retry later.');
}

function respond(status: number, body: unknown, requestId: string): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Request-Id': requestId },
    body: JSON.stringify(body),
  };
}
