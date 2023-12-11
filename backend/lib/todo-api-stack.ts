import { CfnOutput, Stack, StackProps, Aws, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as nodejsfunction from 'aws-cdk-lib/aws-lambda-nodejs';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as path from 'path';

export interface TodoApiStackProps extends StackProps {
  readonly allowedOrigins?: string;
};
export const ApiGatewayEndpointStackOutput = 'ApiEndpoint';
export const ApiGatewayDomainStackOutput = 'ApiDomain';
export const ApiGatewayStageStackOutput = 'ApiStage';

export class TodoApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: TodoApiStackProps) {
    super(scope, id, props);

    const ddb = new dynamodb.Table(this, 'TodosDB', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
    });

    // Create CodeDeploy Application for Stack
    const TodoWebappFullstack = new codedeploy.LambdaApplication(this, 'TodoWebappFullstack', {
      applicationName: 'TodoWebappAPI', // optional property
    });
    
    const getTodos = createFunction(this, 'getTodos', ddb, TodoWebappFullstack, props?.allowedOrigins);
    ddb.grantReadData(getTodos);

    const getTodo = createFunction(this, 'getTodo', ddb, TodoWebappFullstack, props?.allowedOrigins);
    ddb.grantReadData(getTodo);

    const addTodo = createFunction(this, 'addTodo', ddb, TodoWebappFullstack, props?.allowedOrigins);
    ddb.grantWriteData(addTodo);

    const deleteTodo = createFunction(this, 'deleteTodo', ddb, TodoWebappFullstack, props?.allowedOrigins);
    ddb.grantWriteData(deleteTodo);

    const updateTodo = createFunction(this, 'updateTodo', ddb, TodoWebappFullstack, props?.allowedOrigins);
    ddb.grantWriteData(updateTodo);

    const apiGateway = new apigateway.RestApi(this, 'TodoApiGateway', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
      deployOptions: {
        tracingEnabled: true,
      },
    });
    const api = apiGateway.root.addResource('api');

    const todos = api.addResource('todos', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });
   
    todos.addMethod('GET', new apigateway.LambdaIntegration(getTodos));
    todos.addMethod('POST', new apigateway.LambdaIntegration(addTodo));

    const todoId = todos.addResource('{id}',{
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });
    todoId.addMethod('PUT', new apigateway.LambdaIntegration(updateTodo));
    todoId.addMethod('GET', new apigateway.LambdaIntegration(getTodo));
    todoId.addMethod('DELETE', new apigateway.LambdaIntegration(deleteTodo));

    // export apigateway endpoint
    new CfnOutput(this, ApiGatewayEndpointStackOutput, {
      value: apiGateway.url
    });

    new CfnOutput(this, ApiGatewayDomainStackOutput, {
      value: apiGateway.url.split('/')[2]
    });

    new CfnOutput(this, ApiGatewayStageStackOutput, {
      value: apiGateway.deploymentStage.stageName
    });
  }
}
function createFunction(scope: Construct, name: string, ddb: dynamodb.Table, cdapp: codedeploy.LambdaApplication, allowedOrigins?: string) {
  
  var todoFunc =  new nodejsfunction.NodejsFunction(scope, name, {
    currentVersionOptions: {
      removalPolicy: RemovalPolicy.RETAIN,
      retryAttempts: 1,                   // async retry attempts
    },
    runtime: lambda.Runtime.NODEJS_16_X,
    architecture: lambda.Architecture.ARM_64,
    entry: path.join(__dirname, `../lambda/${name}.ts`),
    handler: 'lambdaHandler',
    bundling: {
      externalModules: [
        '@aws-lambda-powertools/commons',
        '@aws-lambda-powertools/logger',
        '@aws-lambda-powertools/metrics',
        '@aws-lambda-powertools/tracer',
      ],
    },
    environment: {
      DDB_TABLE: ddb.tableName,
      ALLOWED_ORIGINS: allowedOrigins || '*',
      POWERTOOLS_SERVICE_NAME: name,
      POWERTOOLS_METRICS_NAMESPACE: 'todoApp',
    },
    layers: [
      lambda.LayerVersion.fromLayerVersionArn(
        scope, `PowertoolsLayer-${name}`, `arn:aws:lambda:${Aws.REGION}:094274105915:layer:AWSLambdaPowertoolsTypeScript:4`
      )
    ],
    tracing: lambda.Tracing.ACTIVE,
  });

    // Create Function + Version/Alias
    var todoFuncAlias = todoFunc.addAlias('live');
    
    // Create Cloudwatch Metric/Alarm to track Average Functions Errors


    var todoFuncErrorRate = todoFunc.metricErrors({
      statistic: cloudwatch.Statistic.AVERAGE,
      period: Duration.minutes(1),
      label: name || ' Todos Lambda failure rate'
    });

    var todoFuncAlarm = new cloudwatch.Alarm(scope, name + ' Lambda failure Alarm', {
      metric: todoFuncErrorRate,
      threshold: 1,
      evaluationPeriods: 1,
    });
    
    // Create CodeDeploy Deployment Group, use Alarm to govern rollback
    new codedeploy.LambdaDeploymentGroup(scope, name + '-BlueGreenDeployment', {
      application: cdapp, 
      alias: todoFuncAlias,
      deploymentConfig: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
      alarms: [
        todoFuncAlarm,
      ],
    });

return todoFuncAlias;
}