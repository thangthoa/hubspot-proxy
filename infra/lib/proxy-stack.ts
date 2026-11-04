import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';

export interface PartnerConfig {
  /** Lowercase letters, digits and dashes; becomes the Cognito app client name. */
  name: string;
  scopes: ('read' | 'write')[];
}

export interface EnvironmentConfig {
  region?: string;
  /** Globally unique prefix for the token endpoint: https://<prefix>.auth.<region>.amazoncognito.com */
  cognitoDomainPrefix: string;
  hubspotBaseUrl?: string;
  partners: PartnerConfig[];
  /** Partner source IPs (CIDR). Empty list = no IP restriction. */
  allowedIps?: string[];
  alarmEmail?: string;
  auditRetentionDays: number;
  throttle: { rateLimit: number; burstLimit: number };
  /** Caps parallel Lambda executions to protect the HubSpot API quota. Needs spare account concurrency. */
  reservedConcurrency?: number;
}

export interface HubSpotProxyStackProps extends cdk.StackProps {
  envName: string;
  config: EnvironmentConfig;
}

const RESOURCE_SERVER_ID = 'namy-api';
const METRIC_NAMESPACE = 'NamyHubspotProxy';

export class HubSpotProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HubSpotProxyStackProps) {
    super(scope, id, props);
    const { envName, config } = props;
    const removalPolicy = envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // --- HubSpot token: created with a random placeholder, the real value is set by Namy after deploy.
    const hubSpotToken = new secretsmanager.Secret(this, 'HubSpotToken', {
      secretName: `namy-hubspot-proxy/${envName}/hubspot-token`,
      description: 'HubSpot private app access token (contacts read/write). Replace the placeholder after deploy.',
      removalPolicy,
    });

    // --- Audit trail of every write, including values before an update.
    const auditTable = new dynamodb.Table(this, 'AuditTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy,
    });
    auditTable.addGlobalSecondaryIndex({
      indexName: 'byClient',
      partitionKey: { name: 'clientId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    });

    // --- Proxy Lambda.
    const functionLogs = new logs.LogGroup(this, 'ProxyFunctionLogs', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy,
    });
    const proxyFunction = new nodejs.NodejsFunction(this, 'ProxyFunction', {
      entry: path.join(__dirname, '../../src/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(25),
      reservedConcurrentExecutions: config.reservedConcurrency,
      logGroup: functionLogs,
      environment: {
        HUBSPOT_SECRET_ARN: hubSpotToken.secretArn,
        HUBSPOT_BASE_URL: config.hubspotBaseUrl ?? 'https://api.hubapi.com',
        AUDIT_TABLE_NAME: auditTable.tableName,
        AUDIT_RETENTION_DAYS: String(config.auditRetentionDays),
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: { minify: true, sourceMap: true, target: 'node22' },
    });
    hubSpotToken.grantRead(proxyFunction);
    auditTable.grantWriteData(proxyFunction);

    // --- Partner identity: OAuth2 client credentials (machine-to-machine).
    const userPool = new cognito.UserPool(this, 'PartnerPool', {
      userPoolName: `namy-hubspot-proxy-${envName}`,
      selfSignUpEnabled: false,
      featurePlan: cognito.FeaturePlan.LITE,
      removalPolicy,
    });
    const domain = userPool.addDomain('TokenDomain', {
      cognitoDomain: { domainPrefix: config.cognitoDomainPrefix },
    });
    const scopes = {
      read: new cognito.ResourceServerScope({ scopeName: 'contacts.read', scopeDescription: 'List and read contacts' }),
      write: new cognito.ResourceServerScope({ scopeName: 'contacts.write', scopeDescription: 'Create and update contacts' }),
    };
    const resourceServer = userPool.addResourceServer('ResourceServer', {
      identifier: RESOURCE_SERVER_ID,
      scopes: [scopes.read, scopes.write],
    });
    for (const partner of config.partners) {
      const client = userPool.addClient(`Partner-${partner.name}`, {
        userPoolClientName: `partner-${partner.name}`,
        generateSecret: true,
        oAuth: {
          flows: { clientCredentials: true },
          scopes: partner.scopes.map((scope) => cognito.OAuthScope.resourceServer(resourceServer, scopes[scope])),
        },
        accessTokenValidity: cdk.Duration.hours(1),
        enableTokenRevocation: true,
        preventUserExistenceErrors: true,
      });
      new cdk.CfnOutput(this, `PartnerClientId-${partner.name}`, { value: client.userPoolClientId });
    }

    // --- REST API: exactly five routes, no DELETE.
    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy,
    });
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: `namy-hubspot-proxy-${envName}`,
      endpointTypes: [apigw.EndpointType.REGIONAL],
      cloudWatchRole: true,
      deployOptions: {
        stageName: envName,
        throttlingRateLimit: config.throttle.rateLimit,
        throttlingBurstLimit: config.throttle.burstLimit,
        metricsEnabled: true,
        loggingLevel: apigw.MethodLoggingLevel.ERROR,
        dataTraceEnabled: false,
        accessLogDestination: new apigw.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
      },
    });
    addJsonGatewayResponses(api);

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'PartnerAuthorizer', {
      cognitoUserPools: [userPool],
    });
    const validator = api.addRequestValidator('RequestValidator', {
      validateRequestBody: true,
      validateRequestParameters: true,
    });
    const contactModel = api.addModel('ContactInput', { contentType: 'application/json', schema: contactInputSchema() });
    const batchModel = api.addModel('BatchContactInput', {
      contentType: 'application/json',
      schema: {
        schema: apigw.JsonSchemaVersion.DRAFT4,
        type: apigw.JsonSchemaType.OBJECT,
        required: ['inputs'],
        additionalProperties: false,
        properties: {
          inputs: { type: apigw.JsonSchemaType.ARRAY, minItems: 1, maxItems: 100, items: contactInputSchema() },
        },
      },
    });

    const integration = new apigw.LambdaIntegration(proxyFunction);
    const secured = (scope: 'read' | 'write'): apigw.MethodOptions => ({
      authorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
      authorizationScopes: [`${RESOURCE_SERVER_ID}/contacts.${scope}`],
      requestValidator: validator,
    });

    const contacts = api.root.addResource('contacts');
    const batch = contacts.addResource('batch');
    const contact = contacts.addResource('{id}');

    contacts.addMethod('GET', integration, {
      ...secured('read'),
      requestParameters: { 'method.request.querystring.limit': false, 'method.request.querystring.after': false },
    });
    contacts.addMethod('POST', integration, { ...secured('write'), requestModels: { 'application/json': contactModel } });
    batch.addMethod('POST', integration, { ...secured('write'), requestModels: { 'application/json': batchModel } });
    contact.addMethod('GET', integration, {
      ...secured('read'),
      requestParameters: { 'method.request.path.id': true },
    });
    contact.addMethod('PATCH', integration, {
      ...secured('write'),
      requestParameters: { 'method.request.path.id': true },
      requestModels: { 'application/json': contactModel },
    });

    // --- WAF: rate limit per IP, known-bad inputs, optional partner IP allowlist.
    // WAF counts per 5 minutes; keep it above the API throttle so the throttle answers first (429).
    const webAcl = buildWebAcl(this, envName, config.allowedIps ?? [], config.throttle.rateLimit * 300);
    const association = new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });
    association.node.addDependency(api.deploymentStage);

    // --- Alarms.
    const alarmTopic = config.alarmEmail ? new sns.Topic(this, 'AlarmTopic') : undefined;
    if (alarmTopic && config.alarmEmail) {
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(config.alarmEmail));
    }
    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, description: string) => {
      const created = new cloudwatch.Alarm(this, id, {
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      if (alarmTopic) created.addAlarmAction(new cwActions.SnsAction(alarmTopic));
    };
    const fiveMinutes = cdk.Duration.minutes(5);

    alarm('LambdaErrors', proxyFunction.metricErrors({ period: fiveMinutes }), 1, 'Proxy Lambda crashed.');
    alarm('Api5xx', api.metricServerError({ period: fiveMinutes }), 5, 'Proxy returned 5xx responses.');
    alarm(
      'AuditWriteFailed',
      logMetric(this, 'AuditWriteFailedFilter', functionLogs, 'AUDIT_WRITE_FAILED', 'AuditWriteFailed').with({ period: fiveMinutes }),
      1,
      'A contact change was applied in HubSpot but its audit record was not stored.',
    );
    alarm(
      'HubSpotRetries',
      logMetric(this, 'HubSpotRetryFilter', functionLogs, 'HUBSPOT_RETRY', 'HubSpotRetries').with({ period: fiveMinutes }),
      20,
      'HubSpot is throttling or failing; check the HubSpot API quota.',
    );

    // --- Outputs.
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'TokenUrl', { value: `${domain.baseUrl()}/oauth2/token` });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'HubSpotSecretName', { value: hubSpotToken.secretName });
    new cdk.CfnOutput(this, 'AuditTableName', { value: auditTable.tableName });
  }
}

function contactInputSchema(): apigw.JsonSchema {
  return {
    schema: apigw.JsonSchemaVersion.DRAFT4,
    type: apigw.JsonSchemaType.OBJECT,
    required: ['properties'],
    additionalProperties: false,
    properties: {
      properties: {
        type: apigw.JsonSchemaType.OBJECT,
        minProperties: 1,
        maxProperties: 50,
        additionalProperties: {
          type: [apigw.JsonSchemaType.STRING, apigw.JsonSchemaType.NUMBER, apigw.JsonSchemaType.BOOLEAN],
        },
      },
    },
  };
}

/** Same JSON error shape as the Lambda for errors API Gateway answers itself. */
function addJsonGatewayResponses(api: apigw.RestApi): void {
  const body = (code: string, message = '$context.error.messageString') =>
    `{"error":{"code":"${code}","message":${message},"requestId":"$context.requestId"}}`;
  const headers = { 'Cache-Control': "'no-store'" };

  // Raised for any method/path that is not defined, e.g. DELETE /contacts/{id}.
  api.addGatewayResponse('RouteNotFound', {
    type: apigw.ResponseType.MISSING_AUTHENTICATION_TOKEN,
    statusCode: '404',
    responseHeaders: headers,
    templates: { 'application/json': body('ROUTE_NOT_FOUND', '"This operation is not supported."') },
  });
  api.addGatewayResponse('Default4xx', {
    type: apigw.ResponseType.DEFAULT_4XX,
    responseHeaders: headers,
    templates: { 'application/json': body('$context.error.responseType') },
  });
  api.addGatewayResponse('Default5xx', {
    type: apigw.ResponseType.DEFAULT_5XX,
    responseHeaders: headers,
    templates: { 'application/json': body('$context.error.responseType') },
  });
}

function buildWebAcl(scope: Construct, envName: string, allowedIps: string[], requestsPer5Min: number): wafv2.CfnWebACL {
  const visibility = (metricName: string) => ({
    cloudWatchMetricsEnabled: true,
    sampledRequestsEnabled: true,
    metricName,
  });
  const rules: wafv2.CfnWebACL.RuleProperty[] = [
    {
      name: 'RateLimitPerIp',
      priority: 0,
      action: { block: {} },
      statement: { rateBasedStatement: { limit: requestsPer5Min, aggregateKeyType: 'IP' } },
      visibilityConfig: visibility('RateLimitPerIp'),
    },
    {
      name: 'KnownBadInputs',
      priority: 1,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesKnownBadInputsRuleSet' } },
      visibilityConfig: visibility('KnownBadInputs'),
    },
  ];

  if (allowedIps.length > 0) {
    const ipSet = new wafv2.CfnIPSet(scope, 'PartnerIps', {
      scope: 'REGIONAL',
      ipAddressVersion: 'IPV4',
      addresses: allowedIps,
    });
    rules.push({
      name: 'AllowPartnerIps',
      priority: 2,
      action: { allow: {} },
      statement: { ipSetReferenceStatement: { arn: ipSet.attrArn } },
      visibilityConfig: visibility('AllowPartnerIps'),
    });
  }

  return new wafv2.CfnWebACL(scope, 'WebAcl', {
    name: `namy-hubspot-proxy-${envName}`,
    scope: 'REGIONAL',
    // With an allowlist, anything that is not a partner IP is blocked.
    defaultAction: allowedIps.length > 0 ? { block: {} } : { allow: {} },
    visibilityConfig: visibility(`namy-hubspot-proxy-${envName}`),
    rules,
  });
}

function logMetric(scope: Construct, id: string, logGroup: logs.ILogGroup, event: string, metricName: string) {
  return new logs.MetricFilter(scope, id, {
    logGroup,
    metricNamespace: METRIC_NAMESPACE,
    metricName,
    filterPattern: logs.FilterPattern.stringValue('$.event', '=', event),
    metricValue: '1',
  }).metric({ statistic: 'Sum' });
}
