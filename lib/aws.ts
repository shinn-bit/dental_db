import { S3Client } from "@aws-sdk/client-s3";
import { SFNClient } from "@aws-sdk/client-sfn";
import { BedrockAgentClient } from "@aws-sdk/client-bedrock-agent";
import { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import { TextractClient } from "@aws-sdk/client-textract";
import { appEnv } from "@/lib/env";

const sharedCredentials = appEnv.awsProfile ? fromIni({ profile: appEnv.awsProfile }) : undefined;

function getCredentials() {
  return sharedCredentials;
}

export function createS3Client() {
  return new S3Client({
    region: appEnv.awsRegion,
    ...(getCredentials() ? { credentials: getCredentials() } : {})
  });
}

export function createStepFunctionsClient() {
  return new SFNClient({
    region: appEnv.awsRegion,
    ...(getCredentials() ? { credentials: getCredentials() } : {})
  });
}

export function createTextractS3Client() {
  return new S3Client({
    region: appEnv.textractRegion,
    ...(getCredentials() ? { credentials: getCredentials() } : {})
  });
}

export function createBedrockAgentClient() {
  return new BedrockAgentClient({
    region: appEnv.awsRegion,
    ...(getCredentials() ? { credentials: getCredentials() } : {})
  });
}

export function createBedrockAgentRuntimeClient() {
  return new BedrockAgentRuntimeClient({
    region: appEnv.awsRegion,
    ...(getCredentials() ? { credentials: getCredentials() } : {})
  });
}

export function createBedrockRuntimeClient() {
  return new BedrockRuntimeClient({
    region: appEnv.awsRegion,
    ...(getCredentials() ? { credentials: getCredentials() } : {})
  });
}

export function createTextractClient() {
  return new TextractClient({
    region: appEnv.textractRegion,
    ...(getCredentials() ? { credentials: getCredentials() } : {})
  });
}
