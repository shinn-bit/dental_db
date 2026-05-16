import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createS3Client } from "@/lib/aws";

export async function bodyToString(body: unknown) {
  if (!body || typeof body !== "object" || !("transformToString" in body)) {
    return "";
  }

  return (body as { transformToString: () => Promise<string> }).transformToString();
}

export async function bodyToBytes(body: unknown) {
  if (!body || typeof body !== "object" || !("transformToByteArray" in body)) {
    return new Uint8Array();
  }

  return (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
}

export async function getS3Text(bucket: string, key: string) {
  const response = await createS3Client().send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key
    })
  );

  return bodyToString(response.Body);
}

export async function getS3Bytes(bucket: string, key: string) {
  const response = await createS3Client().send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key
    })
  );

  return bodyToBytes(response.Body);
}

export async function putS3Text(bucket: string, key: string, body: string, contentType: string) {
  await createS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType
    })
  );
}
