import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { NextRequest, NextResponse } from "next/server";
import { appEnv } from "@/lib/env";
import { fromIni } from "@aws-sdk/credential-providers";

export const maxDuration = 10;

function createLambdaClient() {
  const credentials = appEnv.awsProfile ? fromIni({ profile: appEnv.awsProfile }) : undefined;
  return new LambdaClient({
    region: appEnv.awsRegion,
    ...(credentials ? { credentials } : {}),
  });
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const functionName = process.env.IMAGE_PROCESSOR_FUNCTION_NAME ?? "dental-image-processor-dev";

  try {
    const lambda = createLambdaClient();
    // 非同期で起動（Lambdaは最大15分かかるためfire-and-forget）
    await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ fileId: id })),
      })
    );

    return NextResponse.json({ status: "STARTED", fileId: id });
  } catch (err) {
    console.error("[process-images]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "不明なエラー" },
      { status: 500 }
    );
  }
}
