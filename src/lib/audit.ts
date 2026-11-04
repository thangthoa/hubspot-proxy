import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, type BatchWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { requireEnv } from './env';
import { errorMessage } from './errors';
import { log } from './log';

export interface AuditEntry {
  contactId: string;
  action: 'CREATE' | 'BATCH_CREATE' | 'UPDATE';
  clientId: string;
  requestId: string;
  changedFields: string[];
  /** Values before an update; lets an operator restore a contact a partner damaged. */
  before?: Record<string, string | null>;
  after: Record<string, string | null>;
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const BATCH_WRITE_MAX = 25;
const MAX_ATTEMPTS = 3;

/**
 * Stores one audit record per changed contact.
 * Runs after HubSpot accepted the change, so a failure here must not fail the partner's request:
 * it is logged as AUDIT_WRITE_FAILED, which raises a CloudWatch alarm.
 */
export async function recordAudit(entries: AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const now = new Date();
  const retentionDays = Number(process.env.AUDIT_RETENTION_DAYS ?? '365');
  const items = entries.map((entry, index) => ({
    pk: `contact#${entry.contactId}`,
    sk: `${now.toISOString()}#${entry.requestId}#${index}`,
    ...entry,
    createdAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + retentionDays * 86_400,
  }));

  if (process.env.AUDIT_SINK === 'console') {
    // Local runs only: print instead of writing to DynamoDB.
    console.log(JSON.stringify({ level: 'info', event: 'AUDIT', entries: items }, null, 2));
    return;
  }

  try {
    const table = requireEnv('AUDIT_TABLE_NAME');
    for (let start = 0; start < items.length; start += BATCH_WRITE_MAX) {
      const chunk = items.slice(start, start + BATCH_WRITE_MAX).map((Item) => ({ PutRequest: { Item } }));
      await writeChunk(table, chunk);
    }
  } catch (err) {
    log('error', 'AUDIT_WRITE_FAILED', {
      requestId: entries[0]?.requestId,
      contactIds: entries.map((entry) => entry.contactId),
      error: errorMessage(err),
    });
  }
}

async function writeChunk(table: string, chunk: NonNullable<BatchWriteCommandInput['RequestItems']>[string]) {
  let pending = chunk;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && pending.length > 0; attempt++) {
    const out = await db.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
    pending = out.UnprocessedItems?.[table] ?? [];
  }
  if (pending.length > 0) throw new Error(`${pending.length} audit records were not written`);
}
