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

Every other method or path (DELETE, archive, merge, other CRM objects) **does not exist** on API Gateway and is rejected before reaching the Lambda: `404 ROUTE_NOT_FOUND`, or `403` when the request carries an `Authorization` header (API Gateway then treats the header as an AWS signature). The partner-facing specification is in [openapi.yaml](openapi.yaml).

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
local/server.ts            runs the Lambda on localhost (npm run local)
scripts/e2e.mts            end-to-end checks of a deployed environment (npm run e2e:dev)
scripts/partner-credentials.mts   prints what to send a partner (npm run partner:credentials)
openapi.yaml               API documentation for partners
cdk.json                   per-environment configuration
.env.example               template for .env.local (local runs only)
```

## Setup and deployment

From an empty machine to a partner calling the API.

| Step | Who | Once or repeated |
|---|---|---|
| [1. Prerequisites](#1-prerequisites) | Developer | Once per machine |
| [2. Create the HubSpot key](#2-create-the-hubspot-key) | Namy (HubSpot Super Admin) | Once per environment |
| [3. Configure AWS access](#3-configure-aws-access) | Developer | Once per machine |
| [4. Configure the environment](#4-configure-the-environment) | Developer + Namy | When settings change |
| [5. Run locally (optional)](#5-run-locally-optional) | Developer | Any time |
| [6. Bootstrap the AWS account](#6-bootstrap-the-aws-account) | Developer | Once per account and region |
| [7. Deploy](#7-deploy) | Developer / CI | Every release |
| [8. Store the HubSpot key in AWS](#8-store-the-hubspot-key-in-aws) | Namy | Once, and on key rotation |
| [9. Verify the deployment](#9-verify-the-deployment) | Developer | Every release |
| [10. Onboard a partner](#10-onboard-a-partner) | Namy | Per partner |
| [11. Go to production](#11-go-to-production) | Developer + Namy | Once |

Quick lookup of every value used below: [Values and where to find them](#values-and-where-to-find-them).

---

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 22 or later | `node -v` |
| npm | 10 or later | `npm -v` |
| AWS CLI | v2 | `aws --version` |
| Git | any | `git --version` |

Install the project dependencies:

```bash
git clone git@github.com:thangthoa/hubspot-proxy.git
cd hubspot-proxy
npm install
npm run typecheck
npm test
```

All tests must pass before going further.

## 2. Create the HubSpot key

The proxy needs one HubSpot key with **only** these two scopes:

- `crm.objects.contacts.read`
- `crm.objects.contacts.write`

Without `write`, creating or updating contacts fails with `UPSTREAM_ERROR` (HubSpot answers `403 MISSING_SCOPES`).
Do not add any other scope: if the key leaks, the damage stays limited to contacts.

The menu depends on the age of the HubSpot account:

**New accounts (service key)**

1. HubSpot → **Development** → **Legacy Apps** → **Create a service key**.
2. Name it, e.g. `AWS Proxy – Contacts`.
3. Add the two scopes above, then **Create**.
4. Copy the key immediately; it may not be shown again.

**Older accounts (private app)**

1. HubSpot → **Development** → **Legacy Apps** → **Create legacy app** → **Private**.
2. **Scopes** tab: add the two scopes above.
3. **Create app** → **Auth** tab → **Show token** → copy. The token starts with `pat-`.

Both kinds of key are sent as `Authorization: Bearer <key>`; the proxy works the same with either.

**Use a separate key per environment.** For dev, use a HubSpot sandbox or a test account, never Namy's real customer data.

Check that the key works (the key is read without being echoed or stored in shell history):

```bash
read -rs HUBSPOT_TOKEN && export HUBSPOT_TOKEN
curl -s "https://api.hubapi.com/crm/v3/objects/contacts?limit=2&properties=email" -H "Authorization: Bearer $HUBSPOT_TOKEN"
```

A JSON body with `"results"` means the key works. `401` means the key is wrong; `403` means a scope is missing.

**Never put the key in code, in the repository, in chat or in email.**

## 3. Configure AWS access

You need an IAM user or role that can create CloudFormation stacks, IAM roles, Lambda, API Gateway, Cognito, WAF, DynamoDB, Secrets Manager, CloudWatch and SNS resources.

Configure a named profile (access keys):

```bash
aws configure --profile namy
```

or with IAM Identity Center (SSO):

```bash
aws configure sso --profile namy
aws sso login --profile namy
```

Check which account and user the profile points to:

```bash
aws sts get-caller-identity --profile namy
```

Then select the profile for every command in this guide:

```bash
export AWS_PROFILE=namy
```

> Use separate AWS accounts for dev and prod when possible. A profile's default region does not matter: the deployment region comes from `cdk.json`.

## 4. Configure the environment

### 4.1 Environment settings (`cdk.json`)

Each environment has a block under `context.environments`:

```json
"dev": {
  "region": "ap-southeast-1",
  "cognitoDomainPrefix": "namy-hubspot-proxy-dev",
  "hubspotBaseUrl": "https://api.hubapi.com",
  "partners": [
    { "name": "sample-partner", "scopes": ["read", "write"] },
    { "name": "readonly-tester", "scopes": ["read"] }
  ],
  "allowedIps": [],
  "alarmEmail": "",
  "auditRetentionDays": 30,
  "throttle": { "rateLimit": 10, "burstLimit": 20 }
}
```

| Key | Meaning | Notes |
|---|---|---|
| `region` | AWS region of the whole stack | Agree with Namy (data residency). Changing it later means a new deployment and new URLs |
| `cognitoDomainPrefix` | Prefix of the token URL `https://<prefix>.auth.<region>.amazoncognito.com` | Globally unique across all AWS customers; lowercase letters, digits, dashes; must not contain `aws` or `cognito` |
| `hubspotBaseUrl` | HubSpot API host | Keep `https://api.hubapi.com` |
| `partners` | One Cognito app client per partner | `name`: lowercase, digits, dashes. `scopes`: `["read"]` or `["read","write"]` |
| `allowedIps` | Partner source IPs in CIDR, e.g. `203.0.113.10/32` | Empty = any IP. When set, all other IPs are blocked by WAF |
| `alarmEmail` | Address that receives CloudWatch alarms | Empty = no notifications. AWS sends a confirmation email that must be accepted |
| `auditRetentionDays` | How long audit records are kept | e.g. 30 for dev, 365 for prod |
| `throttle` | API Gateway request rate per second (`rateLimit`) and burst (`burstLimit`) | Keep below the HubSpot API quota of Namy's plan |
| `reservedConcurrency` | Optional cap on concurrent Lambda executions | Only if the AWS account has spare concurrency |

### 4.2 Field policy (`src/lib/config.ts`)

| Constant | Meaning |
|---|---|
| `READ_PROPERTIES` | Fields returned to partners |
| `WRITE_PROPERTIES` | Fields partners may set |
| `NON_CLEARABLE_PROPERTIES` | Fields that can never be set to an empty value |
| `CREATE_REQUIRED_PROPERTIES` | Fields required on create |

The current values are placeholders. Confirm them with Namy, then update `ContactProperties` in [openapi.yaml](openapi.yaml) to match, and run `npm test`.

## 5. Run locally (optional)

Runs the Lambda on `http://localhost:3001` against a real HubSpot account, without AWS. No partner token is needed; every request acts as a partner with both scopes.

```bash
cp .env.example .env.local
# edit .env.local: HUBSPOT_TOKEN=<your test key>
npm run local
```

```bash
curl "http://localhost:3001/contacts?limit=5"
curl -X POST http://localhost:3001/contacts -H "Content-Type: application/json" \
  -d '{"properties":{"email":"test1@example.com","firstname":"Test"}}'
```

- `.env.local` is git-ignored. Use a test HubSpot account only.
- Audit records are printed in the terminal instead of DynamoDB.
- Port busy: set `PORT=3002` in `.env.local`.
- `LOCAL_SCOPES=namy-api/contacts.read` simulates a read-only partner.

## 6. Bootstrap the AWS account

Once per AWS account and region. It creates a CloudFormation stack named `CDKToolkit` that CDK needs before any deployment:

| Resource | Purpose |
|---|---|
| S3 bucket `cdk-hnb659fds-assets-<account>-<region>` | Holds the Lambda code package and templates uploaded during deploys |
| ECR repository | For container images; unused by this project |
| 5 IAM roles | Used by CDK to deploy, publish files and run CloudFormation |
| SSM parameter `/cdk-bootstrap/hnb659fds/version` | Bootstrap version check |

It does not touch existing resources and costs almost nothing.

```bash
npm run bootstrap
```

(equivalent to `npx cdk bootstrap aws://<ACCOUNT_ID>/<region>`).

**Production:** by default the CloudFormation role gets `AdministratorAccess`. For prod, bootstrap with a policy limited to the services this stack uses:

```bash
npx cdk bootstrap aws://<PROD_ACCOUNT>/<region> \
  --cloudformation-execution-policies "arn:aws:iam::<PROD_ACCOUNT>:policy/namy-proxy-deploy"
```

## 7. Deploy

Preview the changes first:

```bash
npx cdk diff --context env=dev
```

Deploy:

```bash
npm run deploy:dev
```

The first deployment takes about 1–2 minutes. It prints and saves the stack outputs to `cdk-outputs-dev.json` (git-ignored):

| Output | Meaning |
|---|---|
| `ApiUrl` | Base URL partners call, e.g. `https://abc123.execute-api.ap-southeast-1.amazonaws.com/dev/` |
| `TokenUrl` | Where partners get access tokens |
| `UserPoolId` | Cognito user pool holding the partner clients |
| `PartnerClientId<name>` | `client_id` of each partner |
| `HubSpotSecretName` | Secrets Manager secret to fill in step 8 |
| `AuditTableName` | DynamoDB table with the audit trail |

API Gateway and Cognito provide these URLs with HTTPS automatically; no domain or certificate is needed. See [Custom domain](#custom-domain-optional) to use a name such as `api.namy.com`.

> Deploying creates billable resources. See [Costs](#costs).

## 8. Store the HubSpot key in AWS

The deployment creates the secret with a random placeholder value. Until it is replaced, every call that reaches HubSpot returns `502 UPSTREAM_ERROR`.

**AWS Console:** Secrets Manager → `namy-hubspot-proxy/<env>/hubspot-token` → **Retrieve secret value** → **Edit** → **Plaintext** → paste the key only (no quotes, no `HUBSPOT_TOKEN=`) → **Save**.

**AWS CLI**, from a shell where `HUBSPOT_TOKEN` is set (step 2):

```bash
aws secretsmanager put-secret-value \
  --region ap-southeast-1 \
  --secret-id namy-hubspot-proxy/dev/hubspot-token \
  --secret-string "$HUBSPOT_TOKEN"
```

The Lambda picks up the new key within 5 minutes, or immediately after HubSpot rejects the old one.
For production, Namy enters the key themselves; developers do not need to see it.

## 9. Verify the deployment

```bash
npm run e2e:dev
```

The script gets real partner tokens from Cognito and checks:

| Check | Expected |
|---|---|
| No token / invalid token | `401` |
| `DELETE /contacts/{id}` | blocked by API Gateway (`403` or `404`), never reaches the Lambda |
| Read-only partner calls `POST /contacts` | rejected |
| Unknown field in an update | `400 FIELD_NOT_ALLOWED` |
| List and read contacts | `200`, only allowlisted fields returned |

`E2E_WRITE=1 npm run e2e:dev` also creates and updates a test contact. Use it only against a HubSpot test account; the contact stays in HubSpot afterwards.

The script needs the `readonly-tester` and `sample-partner` clients, which exist in dev only. Secrets and tokens are never printed.

## 10. Onboard a partner

### 10.1 Create the partner's credentials

1. Add the partner to `partners` in `cdk.json`, with only the scopes it needs:

   ```json
   "partners": [
     { "name": "partner-abc", "scopes": ["read", "write"] }
   ]
   ```

   `name`: lowercase letters, digits and dashes. It becomes the Cognito app client `partner-<name>`.

2. Deploy (step 7). Cognito creates a `client_id` and a `client_secret` for the partner.

### 10.2 Collect what the partner needs

The partner needs **six things**:

| # | Value | Secret? | Example |
|---|---|---|---|
| 1 | API base URL (`ApiUrl`) | No | `https://abc123.execute-api.ap-southeast-1.amazonaws.com/prod/` |
| 2 | Token URL (`TokenUrl`) | No | `https://namy-hubspot-proxy.auth.ap-southeast-1.amazoncognito.com/oauth2/token` |
| 3 | `client_id` | No | `136qgnmu51g8de1sfd5bbeuirk` |
| 4 | `client_secret` | **Yes** | 50+ random characters |
| 5 | `scope` to request | No | `namy-api/contacts.read namy-api/contacts.write` |
| 6 | API specification | No | [openapi.yaml](openapi.yaml) |

**Fastest way: one command prints items 1–5.**

```bash
export AWS_PROFILE=namy
npm run partner:credentials -- dev partner-abc                 # client_secret hidden
npm run partner:credentials -- dev partner-abc --show-secret   # client_secret shown
```

Replace `dev` with `prod` and `partner-abc` with the partner `name` from `cdk.json`. Run `--show-secret` only when you are about to hand the secret over, and clear the terminal afterwards.

**Manual way**, if you prefer the AWS CLI or the console:

| Value | AWS CLI | AWS Console |
|---|---|---|
| `ApiUrl`, `TokenUrl`, `UserPoolId`, every `client_id` | `aws cloudformation describe-stacks --region ap-southeast-1 --stack-name NamyHubspotProxy-dev --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table` | CloudFormation → Stacks → `NamyHubspotProxy-dev` → **Outputs** tab |
| Same values, right after a deploy | `cat cdk-outputs-dev.json` | — |
| `client_id` of each partner, by name | `aws cognito-idp list-user-pool-clients --region ap-southeast-1 --user-pool-id <UserPoolId> --query 'UserPoolClients[].[ClientName,ClientId]' --output table` | Cognito → User pools → `namy-hubspot-proxy-dev` → **App clients** |
| `client_secret` | `aws cognito-idp describe-user-pool-client --region ap-southeast-1 --user-pool-id <UserPoolId> --client-id <client_id> --query 'UserPoolClient.ClientSecret' --output text` | Cognito → User pools → `namy-hubspot-proxy-dev` → **App clients** → `partner-<name>` → **Show client secret** |

In stack outputs the partner's client id is named `PartnerClientId` followed by the partner name without dashes, e.g. `PartnerClientIdpartnerabc` for `partner-abc`.

### 10.3 Hand over

1. Send items 1, 2, 3, 5 and 6 by normal channels (email is fine).
2. Send the **`client_secret` separately, over a secure channel**: a shared password manager entry or a self-destructing link. Never by plain email, chat or ticket.
3. Tell the partner to **reuse each access token until it expires (1 hour)**. Cognito charges for every token request.

### 10.4 What the partner does with it

```bash
# 1. Get an access token from Cognito (not from the proxy)
curl -X POST "<TokenUrl>" -u "<client_id>:<client_secret>" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "scope=namy-api/contacts.read namy-api/contacts.write"
# → {"access_token":"eyJ...","expires_in":3600,"token_type":"Bearer"}

# 2. Call the proxy with the token
curl "<ApiUrl>contacts?limit=20" -H "Authorization: Bearer <access_token>"
```

A partner with only `read` must request `scope=namy-api/contacts.read`; asking for a scope it was not granted fails with `invalid_scope`.

### 10.5 Revoke a partner

Remove it from `partners` and deploy. Its `client_id` and `client_secret` stop working at once; tokens already issued stay valid for up to 1 hour. To cut access immediately, also block its IP in WAF.

## 11. Go to production

Checklist before `npm run deploy:prod`:

- [ ] Field lists in `src/lib/config.ts` and `openapi.yaml` confirmed with Namy
- [ ] Production AWS account, region and deploy profile agreed; account bootstrapped (step 6, restricted policy)
- [ ] `cdk.json` → `prod`: `partners` filled in (an empty list means nobody can get a token), `allowedIps`, `alarmEmail`, `auditRetentionDays`, `throttle`
- [ ] `cognitoDomainPrefix` for prod is unique (deployment fails if the name is taken)
- [ ] Production HubSpot key created by Namy with only the two contact scopes
- [ ] Deployed through CI/CD with an approval step, not from a laptop

```bash
export AWS_PROFILE=<prod-profile>
npm run deploy:prod
```

Then: Namy stores the HubSpot key (step 8, secret `namy-hubspot-proxy/prod/hubspot-token`), confirms the alarm email subscription, and onboards partners (step 10).

In prod, the secret, audit table, user pool and log groups are kept if the stack is deleted (`RemovalPolicy.RETAIN`).

---

## Values and where to find them

`<env>` is `dev` or `prod`. All CLI commands assume `export AWS_PROFILE=<profile>` and use the region from `cdk.json` (`ap-southeast-1` by default).

### Before deploying

| Value | Used for | Secret? | How to get it |
|---|---|---|---|
| HubSpot key | Proxy → HubSpot | **Yes** | HubSpot → Development → Legacy Apps → service key or private app ([step 2](#2-create-the-hubspot-key)) |
| AWS profile | Every AWS command | Holds credentials | `aws configure --profile <name>` or `aws configure sso` ([step 3](#3-configure-aws-access)) |
| AWS account id | Bootstrap | No | `aws sts get-caller-identity --query Account --output text` |
| Region | Whole stack | No | `cdk.json` → `environments.<env>.region` |
| Partner IPs | WAF allowlist | No | Ask each partner for its fixed outbound IPs |
| Alarm email | CloudWatch alarms | No | Ask Namy |

### After deploying

| Value | Used for | Secret? | AWS CLI | AWS Console |
|---|---|---|---|---|
| `ApiUrl` | Partners call it | No | `aws cloudformation describe-stacks --stack-name NamyHubspotProxy-<env> --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text` | CloudFormation → `NamyHubspotProxy-<env>` → Outputs |
| `TokenUrl` | Partners get tokens | No | same command with `TokenUrl` | same place |
| `UserPoolId` | Looking up partner clients | No | same command with `UserPoolId` | Cognito → User pools → `namy-hubspot-proxy-<env>` |
| Partner `client_id` | Partner login | No | `npm run partner:credentials -- <env> <name>` | Cognito → user pool → App clients |
| Partner `client_secret` | Partner login | **Yes** | `npm run partner:credentials -- <env> <name> --show-secret` | Cognito → user pool → App clients → `partner-<name>` → Show client secret |
| HubSpot key secret | Store the HubSpot key | Holds a secret | name: `namy-hubspot-proxy/<env>/hubspot-token` | Secrets Manager → that name |
| Audit table | Who changed what | Contains customer data | output `AuditTableName` | DynamoDB → Tables → name starting with `NamyHubspotProxy-<env>-AuditTable` |
| Lambda logs | Debugging | No customer values | find the group: `aws logs describe-log-groups --log-group-name-prefix NamyHubspotProxy-<env>-ProxyFunctionLogs --query 'logGroups[].logGroupName'`, then `aws logs tail <group-name> --follow` | CloudWatch → Log groups → name containing `ProxyFunctionLogs` |
| Alarms | Monitoring | No | `aws cloudwatch describe-alarms --alarm-name-prefix NamyHubspotProxy-<env>` | CloudWatch → Alarms |

## Custom domain (optional)

Not configured in the current stack. Recommended for prod: the URL stays the same if the stack is ever recreated (the `ApiUrl` id changes), and the default URL can then be disabled.

What is needed:

1. A domain Namy owns and access to its DNS.
2. An ACM certificate for the API domain (e.g. `api.namy.com`) in the **same region** as the API.
   For a custom token domain (e.g. `auth.namy.com`) the certificate must be in **us-east-1**.
3. A DNS record: created by CDK if the zone is in Route 53, otherwise a `CNAME` added by Namy at their DNS provider.
4. A stack change: an API Gateway custom domain with a base path mapping (and optionally a Cognito custom domain).

## Costs

Monthly fees are prorated hourly and stop when the stack is deleted.

| Service | Fixed | Usage |
|---|---|---|
| WAF | ≈ USD 7 / month (web ACL USD 5 + 2 rules × USD 1) | USD 0.60 per million requests |
| Secrets Manager | USD 0.40 / secret / month | negligible |
| CloudWatch alarms | USD 0.10 / alarm / month (4 alarms; free tier covers 10) | — |
| Cognito (machine-to-machine) | none | **USD 0.00225 per token request**, no free tier |
| API Gateway, Lambda, DynamoDB, CloudWatch Logs | none | per request; small at partner volumes |

An idle environment costs about **USD 8 per month**. The main variable cost is Cognito token requests: a partner requesting a new token for every call instead of reusing it can multiply the bill.

## Operations

| Task | How |
|---|---|
| Rotate the HubSpot key | Rotate it in HubSpot, then repeat step 8 |
| Replace a partner's credentials | Rename the partner entry in `cdk.json` (e.g. `abc` → `abc-2`) and deploy: a new `client_id` and secret are created and the old ones deleted. Send the new credentials (step 10) |
| Find who changed a contact | DynamoDB `AuditTableName`: `pk = contact#<id>`; by partner: index `byClient`. `before` holds the previous values |
| Restore a contact | Take `before` from the audit record and send it back with `PATCH /contacts/{id}` (or edit in HubSpot) |
| Read Lambda logs | CloudWatch Logs → log group of `ProxyFunction`; search by `requestId` |
| Alarm `AuditWriteFailed` | A change reached HubSpot without an audit record: find the request by `requestId` in the Lambda logs and record it manually |
| Alarm `HubSpotRetries` | HubSpot is throttling: check the HubSpot API quota, lower `throttle` |

## Tear down

Remove an environment:

```bash
npx cdk destroy --context env=dev
```

In dev everything is deleted, including the audit table and the secret. In prod the secret, audit table, user pool and logs are retained and must be deleted manually if really unwanted.

Remove the CDK bootstrap (only if nothing else in the account uses CDK):

```bash
aws s3 rm s3://cdk-hnb659fds-assets-<account>-<region> --recursive
aws cloudformation delete-stack --stack-name CDKToolkit --region <region>
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Unable to locate credentials` / `NoCredentials` | No AWS profile selected | `export AWS_PROFILE=<profile>` (step 3) |
| Deploy says the environment needs bootstrapping, or `/cdk-bootstrap/... not found` | Account/region not bootstrapped | `npm run bootstrap` (step 6) |
| Deploy fails on the Cognito domain (already exists) | `cognitoDomainPrefix` is taken | Choose another prefix in `cdk.json` |
| Every call returns `502 UPSTREAM_ERROR` | HubSpot rejected the proxy | Check the Lambda log line `REQUEST_FAILED` → `upstream.category`: `INVALID_AUTHENTICATION` = key missing or wrong (step 8); `MISSING_SCOPES` = add `crm.objects.contacts.write` to the key |
| `401` for a partner with a valid-looking token | Token expired (1 hour), from another environment, or missing the scope | Request a new token with the right scope from the right `TokenUrl` |
| `DELETE` returns `403` instead of `404` | API Gateway treats the `Authorization` header as an AWS signature on undefined routes | Expected; the request is blocked either way |
| `npm run local`: `HUBSPOT_TOKEN is not set` | `.env.local` missing or empty | Step 5 |
| `npm run local`: `Port … is already in use` | Another program uses the port | `PORT=3002` in `.env.local` |

## Open questions for Namy

1. Which fields partners may read, may write, may never clear, and must provide on create.
2. Duplicate email on create: currently returns `409 CONTACT_ALREADY_EXISTS`. Should it update the existing contact instead (upsert)?
3. Fixed IP addresses for each partner (to enable `allowedIps`).
4. Alarm email address and audit log retention period.
5. The HubSpot plan in use (API quota), to set `throttle` and `reservedConcurrency` accordingly.
