import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { NextResponse } from "next/server";
import { appEnv } from "@/lib/env";
import { fromIni } from "@aws-sdk/credential-providers";

const FUNCTION_NAME = process.env.SUMMARY_WORKER_FUNCTION_NAME ?? "dental-summary-worker-dev";

function createLambdaClient() {
  const credentials = appEnv.awsProfile ? fromIni({ profile: appEnv.awsProfile }) : undefined;
  return new LambdaClient({
    region: appEnv.awsRegion,
    ...(credentials ? { credentials } : {}),
  });
}

export async function POST() {
  try {
    await createLambdaClient().send(
      new InvokeCommand({
        FunctionName: FUNCTION_NAME,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ action: "run_batch_kb_sync" })),
      })
    );
    return NextResponse.json({ status: "STARTED" });
  } catch (err) {
    console.error("[kb-sync POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "不明なエラー" },
      { status: 500 }
    );
  }
}
