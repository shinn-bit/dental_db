import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { NextRequest, NextResponse } from "next/server";
import { appEnv } from "@/lib/env";
import { fromIni } from "@aws-sdk/credential-providers";

export const maxDuration = 30;

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
    const result = await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify({ fileId: id })),
      })
    );

    const payload = result.Payload
      ? JSON.parse(Buffer.from(result.Payload).toString("utf-8"))
      : {};

    if (result.FunctionError) {
      return NextResponse.json({ error: "Lambda実行エラー", detail: payload }, { status: 500 });
    }

    return NextResponse.json(payload);
  } catch (err) {
    console.error("[process-images]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "不明なエラー" },
      { status: 500 }
    );
  }
}
