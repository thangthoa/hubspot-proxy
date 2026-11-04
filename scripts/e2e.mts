/**
 * End-to-end check of a deployed environment.
 *   AWS_PROFILE=namy npx tsx scripts/e2e.mts cdk-outputs-dev.json
 * Read-only by default. Set E2E_WRITE=1 to also create and update a test contact
 * (only against a HubSpot test account).
 * Never prints client secrets or tokens.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const outputsFile = process.argv[2] ?? 'cdk-outputs-dev.json';
const stackOutputs = Object.values(JSON.parse(readFileSync(outputsFile, 'utf8')))[0] as Record<string, string>;
const output = (prefix: string) => {
  const key = Object.keys(stackOutputs).find((k) => k.startsWith(prefix));
  if (!key) throw new Error(`Output ${prefix}* not found in ${outputsFile}`);
  return stackOutputs[key]!;
};

const apiUrl = output('ApiUrl').replace(/\/$/, '');
const tokenUrl = output('TokenUrl');
const userPoolId = output('UserPoolId');
const region = userPoolId.split('_')[0]!;

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

function clientSecret(clientId: string): string {
  return execFileSync(
    'aws',
    ['cognito-idp', 'describe-user-pool-client', '--region', region, '--user-pool-id', userPoolId,
      '--client-id', clientId, '--query', 'UserPoolClient.ClientSecret', '--output', 'text'],
    { encoding: 'utf8' },
  ).trim();
}

async function token(clientId: string, scope: string): Promise<string> {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret(clientId)}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function call(method: string, path: string, bearer?: string, body?: unknown) {
  const res = await fetch(apiUrl + path, {
    method,
    headers: {
      ...(bearer && { Authorization: `Bearer ${bearer}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const READ = 'namy-api/contacts.read';
const WRITE = 'namy-api/contacts.write';

const writer = await token(output('PartnerClientIdsamplepartner'), `${READ} ${WRITE}`);
const reader = await token(output('PartnerClientIdreadonlytester'), READ);
console.log(`API ${apiUrl}\n`);

let r = await call('GET', '/contacts');
check('No token is rejected', r.status === 401, `HTTP ${r.status}`);

r = await call('GET', '/contacts', 'not-a-real-token');
check('Invalid token is rejected', r.status === 401, `HTTP ${r.status}`);

r = await call('DELETE', '/contacts/1', writer);
// 404 without an Authorization header; 403 with one (API Gateway treats it as a bad SigV4 signature).
check('DELETE is blocked before the Lambda', r.status === 403 || r.status === 404, `HTTP ${r.status}`);

r = await call('POST', '/contacts', reader, { properties: { email: 'blocked@example.com' } });
check('Read-only partner cannot create', r.status === 401 || r.status === 403, `HTTP ${r.status}`);

r = await call('PATCH', '/contacts/1', writer, { properties: { hubspot_owner_id: '1' } });
check('Field outside the allowlist is rejected', r.status === 400 && r.json?.error?.code === 'FIELD_NOT_ALLOWED', `HTTP ${r.status} ${r.json?.error?.code ?? ''}`);

r = await call('GET', '/contacts?limit=2', reader);
const listed = r.status === 200;
check('List contacts (reaches HubSpot)', listed,
  listed ? `${r.json.results.length} contacts` : `HTTP ${r.status} ${r.json?.error?.code ?? ''} — is the HubSpot key stored in Secrets Manager?`);

if (listed && r.json.results[0]) {
  const id = r.json.results[0].id;
  r = await call('GET', `/contacts/${id}`, reader);
  check('Get one contact', r.status === 200 && r.json.id === id, `HTTP ${r.status}`);
  check('Only allowlisted fields are returned', r.status === 200 && !('hs_object_id' in r.json.properties));
}

if (process.env.E2E_WRITE === '1' && listed) {
  const email = `e2e-${Date.now()}@example.com`;
  r = await call('POST', '/contacts', writer, { properties: { email, firstname: 'E2E', lastname: 'Test' } });
  check('Create contact', r.status === 201, `HTTP ${r.status} ${r.json?.error?.code ?? ''}`);
  if (r.status === 201) {
    const id = r.json.id;
    r = await call('PATCH', `/contacts/${id}`, writer, { properties: { city: 'Hanoi' } });
    check('Update contact', r.status === 200 && r.json.properties.city === 'Hanoi', `HTTP ${r.status}`);
    r = await call('PATCH', `/contacts/${id}`, writer, { properties: { email: '' } });
    check('Clearing email is rejected', r.status === 400 && r.json?.error?.code === 'FIELD_CANNOT_BE_CLEARED', `HTTP ${r.status}`);
    console.log(`      test contact id ${id} (${email}) left in HubSpot; delete it there if not needed`);
  }
}

console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
