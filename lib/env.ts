export const appEnv = {
  awsProfile: process.env.AWS_PROFILE || "dental-dev",
  awsRegion: process.env.AWS_REGION || "ap-northeast-1",
  s3BucketName: process.env.S3_BUCKET_NAME || "",
  s3ManualPrefix: process.env.S3_MANUAL_PREFIX || "manuals/",
  s3MetadataPrefix: process.env.S3_METADATA_PREFIX || "metadata/",
  bedrockKnowledgeBaseId: process.env.BEDROCK_KNOWLEDGE_BASE_ID || "",
  bedrockDataSourceId: process.env.BEDROCK_DATA_SOURCE_ID || "",
  bedrockModelArn: process.env.BEDROCK_MODEL_ARN || "",
  sharePassword: process.env.APP_SHARE_PASSWORD || "",
  authSecret: process.env.APP_AUTH_SECRET || ""
};

export function requireEnv(value: string, name: string) {
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}
