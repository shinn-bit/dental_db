import { S3Client } from "@aws-sdk/client-s3";
import { BedrockAgentClient } from "@aws-sdk/client-bedrock-agent";
import { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import { appEnv } from "@/lib/env";

function getCredentials() {
  if (appEnv.awsProfile) {
    return fromIni({ profile: appEnv.awsProfile });
  }

  return undefined;
}

export function createS3Client() {
  return new S3Client({
    region: appEnv.awsRegion,
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
