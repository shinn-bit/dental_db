import { NextResponse } from "next/server";

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}

export function apiErrorResponse(error: unknown, fallback: string, status = 500) {
  const message = getErrorMessage(error);
  console.error(fallback, error);

  return NextResponse.json(
    {
      error: `${fallback}: ${message}`
    },
    { status }
  );
}
