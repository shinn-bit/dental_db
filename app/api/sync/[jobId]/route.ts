import { GetIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";
import { NextResponse } from "next/server";
import { createBedrockAgentClient } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const knowledgeBaseId = requireEnv(appEnv.bedrockKnowledgeBaseId, "BEDROCK_KNOWLEDGE_BASE_ID");
  const dataSourceId = requireEnv(appEnv.bedrockDataSourceId, "BEDROCK_DATA_SOURCE_ID");
  const response = await createBedrockAgentClient().send(
    new GetIngestionJobCommand({
      knowledgeBaseId,
      dataSourceId,
      ingestionJobId: jobId
    })
  );

  return NextResponse.json({ job: response.ingestionJob });
}
