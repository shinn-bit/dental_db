import { ListIngestionJobsCommand, StartIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";
import { NextResponse } from "next/server";
import { createBedrockAgentClient } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";

export async function GET() {
  const knowledgeBaseId = requireEnv(appEnv.bedrockKnowledgeBaseId, "BEDROCK_KNOWLEDGE_BASE_ID");
  const dataSourceId = requireEnv(appEnv.bedrockDataSourceId, "BEDROCK_DATA_SOURCE_ID");
  const response = await createBedrockAgentClient().send(
    new ListIngestionJobsCommand({
      knowledgeBaseId,
      dataSourceId,
      maxResults: 5
    })
  );

  return NextResponse.json({
    jobs: response.ingestionJobSummaries || []
  });
}

export async function POST() {
  const knowledgeBaseId = requireEnv(appEnv.bedrockKnowledgeBaseId, "BEDROCK_KNOWLEDGE_BASE_ID");
  const dataSourceId = requireEnv(appEnv.bedrockDataSourceId, "BEDROCK_DATA_SOURCE_ID");
  const response = await createBedrockAgentClient().send(
    new StartIngestionJobCommand({
      knowledgeBaseId,
      dataSourceId,
      description: "Repository file sync"
    })
  );

  return NextResponse.json({
    job: response.ingestionJob
  });
}
