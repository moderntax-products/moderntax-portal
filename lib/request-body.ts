/**
 * SOC 2 CC7.2 — bounded request-body parsing.
 *
 * `await request.json()` has no built-in body-size cap in Next.js App
 * Router. A single attacker can submit a 100 MB JSON blob and DoS the
 * Lambda by exhausting memory before JSON.parse rejects.
 *
 * `parseJsonBody()` reads the body as text with an upfront Content-Length
 * gate, hard-stops at the byte cap during streaming, and then runs
 * JSON.parse. Routes that previously called `await request.json()`
 * should call `parseJsonBody(request)` instead.
 *
 * Defaults to 256 KB — sensible for all current intake JSON payloads
 * (largest observed is the ERC intake form ~5 KB). Override per-route
 * if a legitimate larger payload is expected.
 */

import { NextResponse } from 'next/server';

export class BodyTooLargeError extends Error {
  status = 413;
  constructor(public limit: number) {
    super(`Request body exceeds ${limit} bytes`);
  }
}

export class InvalidJsonError extends Error {
  status = 400;
  constructor(message = 'Invalid JSON body') {
    super(message);
  }
}

const DEFAULT_LIMIT = 256 * 1024; // 256 KB

/**
 * Read and parse a JSON request body with a byte cap.
 * Throws BodyTooLargeError (413) or InvalidJsonError (400) on rejection.
 */
export async function parseJsonBody<T = any>(
  request: Request,
  maxBytes: number = DEFAULT_LIMIT,
): Promise<T> {
  // Upfront Content-Length check — most attacks declare the bloated
  // length honestly. This short-circuits before any streaming.
  const declaredLen = Number(request.headers.get('content-length') || 0);
  if (declaredLen > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }

  // Belt-and-suspenders: stream and tally bytes. Catches honest payloads
  // that grow during transit and chunked-transfer requests without a
  // Content-Length header.
  const reader = request.body?.getReader();
  if (!reader) {
    // No body at all → treat as empty object so callers don't crash on
    // null deref. Same behavior as request.json() with empty body.
    return {} as T;
  }

  const decoder = new TextDecoder();
  let received = 0;
  const chunks: string[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  const body = chunks.join('');

  if (!body) return {} as T;

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new InvalidJsonError();
  }
}

/**
 * Convenience wrapper: parse + return a NextResponse on failure.
 * Use when the caller wants a one-liner that auto-converts the throw
 * into the right HTTP response.
 *
 *   const parse = await parseJsonBodyOrRespond(request);
 *   if (parse instanceof NextResponse) return parse;
 *   const data = parse;  // narrowed to T
 */
export async function parseJsonBodyOrRespond<T = any>(
  request: Request,
  maxBytes: number = DEFAULT_LIMIT,
): Promise<T | NextResponse> {
  try {
    return await parseJsonBody<T>(request, maxBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
    }
    if (err instanceof InvalidJsonError) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
}
