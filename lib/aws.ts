import { S3Client } from "@aws-sdk/client-s3";
import { BedrockAgentClient } from "@aws-sdk/client-bedrock-agent";
import { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import { appEnv } from "@/lib/env";

export function createS3Client() {
  return new S3Client({
    region: appEnv.awsRegion,
    credentials: fromIni({ profile: appEnv.awsProfile })
  });
}

export function createBedrockAgentClient() {
  return new BedrockAgentClient({
    region: appEnv.awsRegion,
    credentials: fromIni({ profile: appEnv.awsProfile })
  });
}

export function createBedrockAgentRuntimeClient() {
  return new BedrockAgentRuntimeClient({
    region: appEnv.awsRegion,
    credentials: fromIni({ profile: appEnv.awsProfile })
  });
}

export function createBedrockRuntimeClient() {
  return new BedrockRuntimeClient({
    region: appEnv.awsRegion,
    credentials: fromIni({ profile: appEnv.awsProfile })
  });
}
