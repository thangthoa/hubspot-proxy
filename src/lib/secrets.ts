import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { requireEnv } from './env';

const client = new SecretsManagerClient({});
/** Re-read periodically so a rotated HubSpot token is picked up without a redeploy. */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { token: string; expiresAt: number } | undefined;

export async function getHubSpotToken(): Promise<string> {
  // Local runs only (npm run local). The Lambda never has HUBSPOT_TOKEN set.
  const localToken = process.env.HUBSPOT_TOKEN?.trim();
  if (localToken) return localToken;
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const out = await client.send(new GetSecretValueCommand({ SecretId: requireEnv('HUBSPOT_SECRET_ARN') }));
  const token = out.SecretString?.trim();
  if (!token) throw new Error('The HubSpot token secret is empty.');

  cached = { token, expiresAt: Date.now() + CACHE_TTL_MS };
  return token;
}

export function clearHubSpotTokenCache(): void {
  cached = undefined;
}
