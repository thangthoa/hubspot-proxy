import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      HUBSPOT_BASE_URL: 'https://api.hubspot.test',
      HUBSPOT_SECRET_ARN: 'arn:aws:secretsmanager:ap-southeast-1:000000000000:secret:test',
      AUDIT_TABLE_NAME: 'audit-test',
      AUDIT_RETENTION_DAYS: '30',
    },
  },
});
