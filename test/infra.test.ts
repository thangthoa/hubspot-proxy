import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { HubSpotProxyStack } from '../infra/lib/proxy-stack';

function synth(allowedIps: string[] = []): Template {
  // Skip esbuild bundling: these tests only inspect the CloudFormation template.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new HubSpotProxyStack(app, 'Test', {
    envName: 'dev',
    config: {
      cognitoDomainPrefix: 'namy-proxy-test',
      partners: [
        { name: 'reader', scopes: ['read'] },
        { name: 'writer', scopes: ['read', 'write'] },
      ],
      allowedIps,
      auditRetentionDays: 30,
      throttle: { rateLimit: 10, burstLimit: 20 },
    },
  });
  return Template.fromStack(stack);
}

describe('HubSpotProxyStack', () => {
  const template = synth();

  it('exposes exactly the five allowed operations, all behind Cognito scopes', () => {
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method')).map((m) => m.Properties);
    expect(methods.map((m) => m.HttpMethod).sort()).toEqual(['GET', 'GET', 'PATCH', 'POST', 'POST']);
    for (const method of methods) {
      expect(method.AuthorizationType).toBe('COGNITO_USER_POOLS');
      expect(method.AuthorizationScopes).toHaveLength(1);
    }
  });

  it('never defines DELETE or ANY methods', () => {
    template.resourcePropertiesCountIs('AWS::ApiGateway::Method', { HttpMethod: 'DELETE' }, 0);
    template.resourcePropertiesCountIs('AWS::ApiGateway::Method', { HttpMethod: 'ANY' }, 0);
  });

  it('gives each partner a client-credentials app client with only its scopes', () => {
    const clients = Object.values(template.findResources('AWS::Cognito::UserPoolClient')).map((c) => c.Properties);
    const scopesOf = (name: string) => {
      const client = clients.find((c) => c.ClientName === `partner-${name}`);
      expect(client).toMatchObject({ GenerateSecret: true, AllowedOAuthFlows: ['client_credentials'] });
      return client.AllowedOAuthScopes.map((scope: unknown) => JSON.stringify(scope).match(/contacts\.(read|write)/)?.[0]);
    };
    expect(scopesOf('reader')).toEqual(['contacts.read']);
    expect(scopesOf('writer')).toEqual(['contacts.read', 'contacts.write']);
  });

  it('lets only the Lambda read the HubSpot token', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'] }),
        ]),
      },
    });
  });

  it('attaches a WAF that allows traffic when no partner IPs are configured', () => {
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    template.hasResourceProperties('AWS::WAFv2::WebACL', { DefaultAction: { Allow: {} } });
  });

  it('blocks everything except partner IPs once an allowlist is set', () => {
    const restricted = synth(['203.0.113.10/32']);
    restricted.hasResourceProperties('AWS::WAFv2::WebACL', { DefaultAction: { Block: {} } });
    restricted.hasResourceProperties('AWS::WAFv2::IPSet', { Addresses: ['203.0.113.10/32'] });
  });
});
