/**
 * node:http request/response helpers for the auth gate routes: JSON body
 * reading with a byte cap, JSON replies, and redirects. Every body-consuming
 * route is a small same-origin `fetch` from the gate's own pages, so the
 * carrier accepts only `application/json` and caps the buffered body far below
 * anything a credential form needs.
 * @module @deepseek-ai/dsh-auth-gate/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Body byte cap for every gate endpoint; credential and administration payloads are small. */
export const MAX_AUTH_BODY_BYTES = 64 * 1024

/**
 * Write one JSON reply.
 * @param res - the response to complete.
 * @param status - the HTTP status code.
 * @param value - the JSON-serializable body.
 * @param headers - extra headers (the session cookie on login, its expiry on logout).
 */
export function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(value))
}

/**
 * Answer one redirect.
 * @param res - the response to complete.
 * @param location - the redirect target path.
 */
export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location })
  res.end()
}

/**
 * Read and parse one JSON object request body, writing the error reply on any
 * failure: 415 for a non-JSON media type, 413 past the byte cap, 400 for
 * malformed JSON or a non-object document.
 * @param req - the request whose body is consumed.
 * @param res - the response an error reply is written to.
 * @returns the parsed object, or undefined once an error reply has been sent.
 */
export async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    sendJson(res, 415, { error: 'content type must be application/json' })
    return undefined
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > MAX_AUTH_BODY_BYTES) {
      sendJson(res, 413, { error: 'request body too large' })
      return undefined
    }
    chunks.push(buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    sendJson(res, 400, { error: 'body is not JSON' })
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, { error: 'body must be a JSON object' })
    return undefined
  }
  return parsed as Record<string, unknown>
}
