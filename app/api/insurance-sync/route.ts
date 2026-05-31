import { ListIngestionJobsCommand, StartIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";
import { NextResponse } from "next/server";
import { createBedrockAgentClient } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";

export async function GET() {
  const knowledgeBaseId = requireEnv(appEnv.bedrockKnowledgeBaseId, "BEDROCK_KNOWLEDGE_BASE_ID");
  const dataSourceId = requireEnv(appEnv.bedrockDataSourceId, "BEDROCK_DATA_SOURCE_ID");
  const response = await createBedrockAgentClient().send(
    new ListIngestionJobsCommand({ knowledgeBaseId, dataSourceId, maxResults: 1 })
  );
  const latest = response.ingestionJobSummaries?.[0];
  return NextResponse.json({ status: latest?.status ?? "UNKNOWN", updatedAt: latest?.updatedAt });
}

export async function POST() {
  const knowledgeBaseId = requireEnv(appEnv.bedrockKnowledgeBaseId, "BEDROCK_KNOWLEDGE_BASE_ID");
  const dataSourceId = requireEnv(appEnv.bedrockDataSourceId, "BEDROCK_DATA_SOURCE_ID");
  try {
    const response = await createBedrockAgentClient().send(
      new StartIngestionJobCommand({
        knowledgeBaseId,
        dataSourceId,
        description: "Insurance rules sync",
      })
    );
    return NextResponse.json({ jobId: response.ingestionJob?.ingestionJobId, status: response.ingestionJob?.status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
