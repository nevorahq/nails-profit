import { NextResponse } from "next/server";

export function requestId(request: Request) {
  return request.headers.get("x-request-id") ?? crypto.randomUUID();
}

export function apiError(status: number, code: string, message: string, id: string) {
  return NextResponse.json(
    { error: { code, message }, requestId: id },
    { status, headers: { "x-request-id": id } },
  );
}
