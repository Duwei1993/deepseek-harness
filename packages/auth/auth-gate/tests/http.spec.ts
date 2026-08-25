/** Unit coverage for the gate's HTTP helpers: body reading bounds and reply shapes. */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { MAX_AUTH_BODY_BYTES, readJsonBody, redirect, sendJson } from '../src/http.ts'

/** Request stub carrying the given headers and body chunks. */
function fakeRequest(headers: Record<string, string>, chunks: Buffer[] = []): IncomingMessage {
  const request = Readable.from(chunks) as unknown as IncomingMessage
  Object.assign(request, { url: '/auth/login', method: 'POST', headers })
  return request
}

/** Response stub state: status, headers, and body. */
interface FakeState { status?: number; headers?: Record<string, string> | undefined; body?: string | undefined }

/** Response stub recording status, headers, and body. */
function fakeResponse(): { response: ServerResponse; state: FakeState } {
  const state: FakeState = {}
  const response = Object.assign(new EventEmitter(), {
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      state.headers = headers
      return this
    },
    end(value?: string) {
      state.body = value
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

describe('sendJson and redirect', () => {
  it('writes the JSON body with merged headers', () => {
    const { response, state } = fakeResponse()
    sendJson(response, 418, { a: 1 }, { 'set-cookie': 'x=1' })
    expect(state).toEqual({
      status: 418,
      headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'x=1' },
      body: '{"a":1}',
    })
  })

  it('writes a 302 redirect', () => {
    const { response, state } = fakeResponse()
    redirect(response, '/auth/login')
    expect(state).toEqual({ status: 302, headers: { location: '/auth/login' }, body: undefined })
  })
})

describe('readJsonBody', () => {
  it('parses a JSON object body', async () => {
    const { response, state } = fakeResponse()
    const body = await readJsonBody(
      fakeRequest({ 'content-type': 'application/json; charset=utf-8' }, [Buffer.from('{"a":1}')]),
      response,
    )
    expect(body).toEqual({ a: 1 })
    expect(state.status).toBeUndefined()
  })

  it('rejects a non-JSON media type with 415', async () => {
    const { response, state } = fakeResponse()
    expect(await readJsonBody(fakeRequest({ 'content-type': 'text/plain' }, [Buffer.from('{}')]), response)).toBeUndefined()
    expect(state.status).toBe(415)
    const absent = fakeResponse()
    expect(await readJsonBody(fakeRequest({}, [Buffer.from('{}')]), absent.response)).toBeUndefined()
    expect(absent.state.status).toBe(415)
  })

  it('rejects an over-cap body with 413', async () => {
    const { response, state } = fakeResponse()
    const big = Buffer.alloc(MAX_AUTH_BODY_BYTES + 1, 97)
    expect(await readJsonBody(fakeRequest({ 'content-type': 'application/json' }, [big]), response)).toBeUndefined()
    expect(state.status).toBe(413)
  })

  it('rejects malformed JSON and non-object documents with 400', async () => {
    for (const raw of ['{', '[1]', 'null', '"s"']) {
      const { response, state } = fakeResponse()
      expect(await readJsonBody(fakeRequest({ 'content-type': 'application/json' }, [Buffer.from(raw)]), response)).toBeUndefined()
      expect(state.status).toBe(400)
    }
  })
})
