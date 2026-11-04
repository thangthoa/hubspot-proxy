# Namy HubSpot Proxy

A proxy API on AWS that lets third-party partners **read, create and update** contacts in Namy's HubSpot account, with **no way to delete them**. Partners never hold the HubSpot token: it lives in AWS Secrets Manager and only the Lambda function can read it.

```
Partner ──① client_id/secret──► Cognito ──► access token (1 hour, scoped)
   │
   └──② Bearer token──► WAF ──► API Gateway (5 routes, scope check, body validation)
                                    └──► Lambda ──► HubSpot API
                                           ├── Secrets Manager (HubSpot token)
                                           └── DynamoDB (audit log: who changed what, before/after values)
```

## What partners can do

| Endpoint | Scope | HubSpot call |
|---|---|---|
| `GET /contacts?limit=&after=` | `namy-api/contacts.read` | `GET /crm/v3/objects/contacts` |
| `GET /contacts/{id}` | `namy-api/contacts.read` | `GET /crm/v3/objects/contacts/{id}` |
| `POST /contacts` | `namy-api/contacts.write` | `POST /crm/v3/objects/contacts` |
| `POST /contacts/batch` (≤ 100) | `namy-api/contacts.write` | `POST /crm/v3/objects/contacts/batch/create` |
| `PATCH /contacts/{id}` | `namy-api/contacts.write` | `PATCH /crm/v3/objects/contacts/{id}` |

Every other method or path (DELETE, archive, merge, other CRM objects) **does not exist** on API Gateway and returns `404 ROUTE_NOT_FOUND`. The partner-facing specification is in [openapi.yaml](openapi.yaml).

## Safeguards

- **No delete route.** The Lambda also rejects any route outside its list (405), in case the API Gateway configuration is changed by mistake.
- **Field allowlists** in [src/lib/config.ts](src/lib/config.ts):
  - `READ_PROPERTIES`: fields returned to partners; everything else is filtered out.
  - `WRITE_PROPERTIES`: fields partners may write; anything else returns `400 FIELD_NOT_ALLOWED`.
  - `NON_CLEARABLE_PROPERTIES`: fields that cannot be emptied through an update (blocks "deleting" data via update).
  - `CREATE_REQUIRED_PROPERTIES`: fields required when creating a contact.
- **Audit log** (DynamoDB): every create and update records the `clientId`, the contact, the changed fields and **the values before the change**, so a contact can be restored. The table is encrypted, has point-in-time recovery, and expires records after `auditRetentionDays`.
- **Scopes are checked twice**: by API Gateway (Cognito authorizer) and again in the Lambda.
- **POST is never retried** after a HubSpot 5xx or timeout (to avoid duplicate contacts); it is retried only on `429`. GET and PATCH are retried up to 3 times on `429`, `5xx` or network errors, but not after a timeout, so the Lambda stays within its time limit.
- **HubSpot errors are not exposed**: a HubSpot authentication failure is returned to partners as `502 UPSTREAM_ERROR`.
- **WAF**: per-IP request limit over 5 minutes (= `throttle.rateLimit` × 300), blocks common malicious inputs, and can optionally allow partner IPs only.
- **Logs contain no customer data values**, only ids and field names.
- **CloudWatch alarms**: Lambda errors, API 5xx responses, failed audit writes, and frequent HubSpot throttling.

> ⚠️ The field lists in `src/lib/config.ts` are **placeholder values**. Confirm them with Namy before going to production, and update `ContactProperties` in `openapi.yaml` to match.

## Project structure

```
infra/bin/app.ts           picks the environment (dev/prod) from cdk.json
infra/lib/proxy-stack.ts   all infrastructure: Cognito, API Gateway, WAF, Lambda, Secrets Manager, DynamoDB, alarms
src/handler.ts             Lambda entry point: routes the 5 operations
src/lib/                   config (allowlists), validation, HubSpot client, secrets, audit, logging, errors
test/                      Lambda unit tests and infrastructure template tests
openapi.yaml               API documentation for partners
cdk.json                   per-environment configuration
```

## Environment configuration (`cdk.json` → `context.environments`)

| Key | Meaning |
|---|---|
| `region` | AWS region; defaults to `ap-southeast-1` |
| `cognitoDomainPrefix` | Prefix of the token URL; must be **globally unique** and must not contain `aws` or `cognito` |
| `partners` | Partner list: `{ "name": "abc", "scopes": ["read"] }` or `["read","write"]` |
| `allowedIps` | Partner IPs in CIDR form (e.g. `203.0.113.10/32`); empty = no IP restriction |
| `alarmEmail` | Address that receives alarms; empty = no notifications |
| `auditRetentionDays` | How many days audit records are kept |
| `throttle` | API request rate limits (per second) |
| `reservedConcurrency` | (optional) Caps concurrent Lambda executions to protect the HubSpot API quota. Requires spare concurrency in the AWS account |

## Run and test locally

```bash
npm install
npm run typecheck
npm test
npx cdk synth --context env=dev
```

### Run the proxy locally against a real HubSpot account

`npm run local` serves the Lambda on `http://localhost:3001`, reading the HubSpot key from `HUBSPOT_TOKEN` instead of Secrets Manager and printing audit records to the console instead of DynamoDB. Use a test HubSpot account, not Namy's production data.

```bash
cp .env.example .env.local   # then paste the key after HUBSPOT_TOKEN= in .env.local
npm run local
```

`.env.local` is git-ignored. Alternatively, skip the file and export the key in the same shell: `read -rs HUBSPOT_TOKEN && export HUBSPOT_TOKEN && npm run local`.

Then, from another terminal:

```bash
curl "http://localhost:3001/contacts?limit=5"
curl "http://localhost:3001/contacts/<id>"
curl -X POST http://localhost:3001/contacts -H "Content-Type: application/json" \
  -d '{"properties":{"email":"test1@example.com","firstname":"Test"}}'
curl -X POST http://localhost:3001/contacts/batch -H "Content-Type: application/json" \
  -d '{"inputs":[{"properties":{"email":"test2@example.com"}},{"properties":{"email":"test3@example.com"}}]}'
curl -X PATCH http://localhost:3001/contacts/<id> -H "Content-Type: application/json" \
  -d '{"properties":{"city":"Hanoi"}}'
curl -X DELETE http://localhost:3001/contacts/<id>   # rejected: METHOD_NOT_ALLOWED
```

No partner token is needed locally: every request acts as a partner holding both scopes. Set `LOCAL_SCOPES=namy-api/contacts.read` to test a read-only partner.

## Deploy

**1. Prepare (once per account and region):**

```bash
npx cdk bootstrap aws://<ACCOUNT_ID>/ap-southeast-1
```

**2. Deploy:**

```bash
npm run deploy:dev
```

Production: `npm run deploy:prod`. Run it through CI/CD with an approval step rather than deploying by hand.

**3. Store the real HubSpot token in Secrets Manager** (done by Namy; the secret is created with a random placeholder value):

```bash
aws secretsmanager put-secret-value \
  --secret-id namy-hubspot-proxy/dev/hubspot-token \
  --secret-string 'pat-na1-xxxxxxxx'
```

- dev: use a **HubSpot sandbox** or test account, never real customer data.
- Create the key in HubSpot with only the `crm.objects.contacts.read` and `crm.objects.contacts.write` scopes:
  - **New HubSpot accounts:** Development → Legacy Apps → **Create a service key**.
  - **Older accounts:** Development → Legacy Apps → Create legacy app → Private (token starts with `pat-`).
  - Both are sent as `Authorization: Bearer <key>`; the proxy works the same with either.
- The Lambda picks up a new token within 5 minutes, or immediately when HubSpot returns 401.

**4. Collect the credentials for a partner.** The `client_id` is in the stack output `PartnerClientId-<name>`. Get the `client_secret` with:

```bash
aws cognito-idp describe-user-pool-client \
  --user-pool-id <UserPoolId> --client-id <client_id> \
  --query 'UserPoolClient.ClientSecret' --output text
```

Send the partner the `client_id`, `client_secret`, `TokenUrl`, `ApiUrl` and `openapi.yaml`. **Share the `client_secret` over a secure channel** (a shared password manager or a self-destructing link), never by plain email or chat.

## Calling the API (partner side)

```bash
# Get a token (reuse it until it expires after 1 hour)
curl -X POST "<TokenUrl>" \
  -u "<client_id>:<client_secret>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&scope=namy-api/contacts.read namy-api/contacts.write"

# Call the API
curl "<ApiUrl>contacts?limit=20" -H "Authorization: Bearer <access_token>"

curl -X PATCH "<ApiUrl>contacts/101" \
  -H "Authorization: Bearer <access_token>" -H "Content-Type: application/json" \
  -d '{"properties":{"city":"Hanoi"}}'
```

## Operations

- **Add a partner:** add it to `partners` in `cdk.json`, redeploy, then get its `client_secret` as in step 4.
- **Revoke a partner:** remove it from `partners` and redeploy. Tokens already issued stay valid for up to 1 hour; to block immediately, add a WAF rule that blocks the partner's IP.
- **Rotate the HubSpot key:** rotate it in HubSpot (service key or private app), then run the `put-secret-value` command from step 3 again.
- **Find who changed a contact:** query the DynamoDB table (output `AuditTableName`) with `pk = contact#<id>`; to search by partner, use the `byClient` index. The `before` attribute holds the previous values for restoring.
- **`AuditWriteFailed` alarm:** a change reached HubSpot but its audit record was not stored. Look up the Lambda's CloudWatch logs by `requestId` and add the record manually.

## Open questions for Namy

1. Which fields partners may read, may write, may never clear, and must provide on create.
2. Duplicate email on create: currently returns `409 CONTACT_ALREADY_EXISTS`. Should it update the existing contact instead (upsert)?
3. Fixed IP addresses for each partner (to enable `allowedIps`).
4. Alarm email address and audit log retention period.
5. The HubSpot plan in use (API quota), to set `throttle` and `reservedConcurrency` accordingly.
