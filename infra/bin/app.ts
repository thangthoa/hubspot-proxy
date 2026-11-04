#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { HubSpotProxyStack, type EnvironmentConfig } from '../lib/proxy-stack';

const app = new cdk.App();
const envName: string = app.node.tryGetContext('env') ?? 'dev';
const environments = app.node.tryGetContext('environments') as Record<string, EnvironmentConfig> | undefined;
const config = environments?.[envName];
if (!config) {
  throw new Error(`No configuration for env "${envName}" in cdk.json → context.environments`);
}

new HubSpotProxyStack(app, `NamyHubspotProxy-${envName}`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region ?? process.env.CDK_DEFAULT_REGION },
  envName,
  config,
});
cdk.Tags.of(app).add('project', 'namy-hubspot-proxy');
cdk.Tags.of(app).add('environment', envName);
