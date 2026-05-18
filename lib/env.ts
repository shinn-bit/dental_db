export const appEnv = {
  awsProfile: process.env.AWS_PROFILE || "",
  awsRegion: process.env.APP_AWS_REGION || process.env.AWS_REGION || "ap-northeast-1",
  textractRegion: process.env.APP_TEXTRACT_REGION || process.env.TEXTRACT_REGION || "ap-northeast-2",
  textractBucketName: process.env.APP_TEXTRACT_BUCKET_NAME || process.env.TEXTRACT_BUCKET_NAME || "",
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
