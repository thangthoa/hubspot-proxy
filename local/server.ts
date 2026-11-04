/**
 * Runs the proxy Lambda on http://localhost:3001 for manual testing against a real HubSpot account.
 * Settings come from the shell or from .env.local (git-ignored; copy .env.example):
 *   HUBSPOT_TOKEN   HubSpot service key / private app token (required)
 *   LOCAL_SCOPES    scopes the fake partner token carries (default: read and write)
 *   PORT            default 3001
 * Audit records are printed to the console instead of DynamoDB.
 */
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../src/handler';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
process.env.AUDIT_SINK = 'console';
const port = Number(process.env.PORT ?? 3001);
const scopes = process.env.LOCAL_SCOPES ?? 'namy-api/contacts.read namy-api/contacts.write';

if (!process.env.HUBSPOT_TOKEN) {
  console.error('HUBSPOT_TOKEN is not set. Copy .env.example to .env.local and paste your HubSpot key into it.');
  process.exit(1);
}

/** Mirrors the API Gateway resources defined in infra/lib/proxy-stack.ts. */
function matchResource(path: string): { resource: string; pathParameters: Record<string, string> | null } {
  if (path === '/contacts' || path === '/contacts/batch') return { resource: path, pathParameters: null };
  const id = /^\/contacts\/([^/]+)$/.exec(path)?.[1];
  if (id) return { resource: '/contacts/{id}', pathParameters: { id: decodeURIComponent(id) } };
  return { resource: path, pathParameters: null };
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const { resource, pathParameters } = matchResource(url.pathname);
  const query = Object.fromEntries(url.searchParams);

  const event = {
    httpMethod: req.method ?? 'GET',
    resource,
    path: url.pathname,
    pathParameters,
    queryStringParameters: Object.keys(query).length > 0 ? query : null,
    body: await readBody(req),
    isBase64Encoded: false,
    requestContext: {
      requestId: `local-${Date.now()}`,
      authorizer: { claims: { client_id: 'local-partner', scope: scopes } },
    },
  } as unknown as APIGatewayProxyEvent;

  const result = await handler(event);
  res.writeHead(result.statusCode, result.headers as Record<string, string>);
  res.end(result.body);
})
  .on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`Port ${port} is already in use. Set another port, e.g. PORT=3002 in .env.local.`);
    process.exit(1);
  })
  .listen(port, () => {
    console.log(`Proxy running on http://localhost:${port}  (scopes: ${scopes})`);
  });
