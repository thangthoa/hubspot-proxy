/**
 * Prints everything a partner needs to call the API, read from the deployed stack.
 *   npm run partner:credentials -- <env> <partner-name> [--show-secret]
 * Without --show-secret the client secret is not printed, only the command to get it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [envName, partnerName] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const showSecret = process.argv.includes('--show-secret');
if (!envName || !partnerName) {
  console.error('Usage: npm run partner:credentials -- <env> <partner-name> [--show-secret]');
  process.exit(1);
}

const cdkJson = JSON.parse(readFileSync('cdk.json', 'utf8'));
const env = cdkJson.context.environments[envName];
if (!env) throw new Error(`Environment "${envName}" not found in cdk.json`);
const partner = (env.partners as { name: string; scopes: string[] }[]).find((p) => p.name === partnerName);
if (!partner) {
  const names = (env.partners as { name: string }[]).map((p) => p.name).join(', ') || '(none)';
  throw new Error(`Partner "${partnerName}" not found in cdk.json → ${envName}. Known partners: ${names}`);
}

const region: string = env.region;
const stackName = `NamyHubspotProxy-${envName}`;
const aws = (...args: string[]) => execFileSync('aws', [...args, '--region', region], { encoding: 'utf8' }).trim();

let stackOutputs: { OutputKey: string; OutputValue: string }[];
try {
  stackOutputs = JSON.parse(
    execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stackName, '--region', region,
      '--query', 'Stacks[0].Outputs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  );
} catch (err) {
  const reason = String((err as { stderr?: string }).stderr ?? err).trim();
  console.error(reason.includes('does not exist')
    ? `Stack ${stackName} is not deployed in ${region}. Deploy it first: npm run deploy:${envName}`
    : `Could not read stack ${stackName}: ${reason}\nIs AWS_PROFILE set to the right account?`);
  process.exit(1);
}
const outputs: Record<string, string> = Object.fromEntries(stackOutputs.map((o) => [o.OutputKey, o.OutputValue]));
const clientId = outputs[`PartnerClientId${partnerName.replace(/[^A-Za-z0-9]/g, '')}`];
if (!clientId) throw new Error(`No client id output for "${partnerName}". Deploy ${envName} after adding the partner.`);

const scope = partner.scopes.map((s) => `namy-api/contacts.${s}`).join(' ');
const secretCommand = `aws cognito-idp describe-user-pool-client --region ${region} --user-pool-id ${outputs.UserPoolId} --client-id ${clientId} --query 'UserPoolClient.ClientSecret' --output text`;
const clientSecret = showSecret
  ? aws('cognito-idp', 'describe-user-pool-client', '--user-pool-id', outputs.UserPoolId!, '--client-id', clientId,
      '--query', 'UserPoolClient.ClientSecret', '--output', 'text')
  : undefined;

console.log(`Environment   ${envName} (${region}, stack ${stackName})
Partner       ${partnerName}

Send to the partner:
  API base URL   ${outputs.ApiUrl}
  Token URL      ${outputs.TokenUrl}
  client_id      ${clientId}
  client_secret  ${clientSecret ?? '(hidden; rerun with --show-secret, or run the command below)'}
  scope          ${scope}
  API spec       openapi.yaml

Send the client_secret over a secure channel only (password manager, self-destructing link).`);

if (!showSecret) console.log(`\nGet the client_secret:\n  ${secretCommand}`);
