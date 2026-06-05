"""
dental-prepare-consumer-dev

SQSキューからfileIdを受け取り、dental-prepare-worker-dev ステートマシンを起動する。
concurrency=5 を Lambda に設定することで同時実行を最大5件に制限する。

SQSメッセージ形式:
  {"fileId": "<uuid>"}
"""

import json
import os
import time

import boto3

AWS_REGION   = os.environ.get("APP_AWS_REGION") or os.environ.get("AWS_REGION") or "ap-northeast-1"
SM_ARN       = os.environ.get("PREPARE_STATE_MACHINE_ARN", "")

sfn = boto3.client("stepfunctions", region_name=AWS_REGION)


def handler(event, context):
    failures = []

    for record in event.get("Records", []):
        message_id = record["messageId"]
        try:
            body    = json.loads(record["body"])
            file_id = body["fileId"]
        except Exception as e:
            print(f"[consumer] メッセージ解析失敗 {message_id}: {e}")
            failures.append({"itemIdentifier": message_id})
            continue

        # 実行名: 同一fileIdで重複しないようタイムスタンプを付与
        exec_name = f"prepare-{file_id}-{int(time.time() * 1000)}"
        # Step Functions の名前制約: 80文字以内・英数字とハイフン等
        exec_name = exec_name[:80]

        try:
            sfn.start_execution(
                stateMachineArn=SM_ARN,
                name=exec_name,
                input=json.dumps({"fileId": file_id}),
            )
            print(f"[consumer] 起動: {file_id}")
        except sfn.exceptions.ExecutionAlreadyExists:
            # 同名実行が既にある（重複起動）→ 正常扱い
            print(f"[consumer] 重複スキップ: {file_id}")
        except Exception as e:
            print(f"[consumer] 起動失敗 {file_id}: {e}")
            # SQSにリトライさせる
            failures.append({"itemIdentifier": message_id})

    # 失敗したメッセージIDを返すとSQSが可視性タイムアウト後に再配信する
    return {"batchItemFailures": failures}
