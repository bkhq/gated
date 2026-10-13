import { describe, expect, it } from 'vitest'
import { parseAsciiCastLine, parseRecordingStreamFrame } from './types'

describe('parseAsciiCastLine', () => {
  it('parses a v2 header with optional fields', () => {
    const line = parseAsciiCastLine('{"version":2,"width":120,"height":40,"title":"shell","time":0.0}')
    expect(line).toEqual({ version: 2, width: 120, height: 40, title: 'shell', time: 0 })
  })

  it('parses a header without optional fields', () => {
    const line = parseAsciiCastLine('{"version":2,"width":80,"height":24}')
    expect(line).toEqual({ version: 2, width: 80, height: 24 })
  })

  it('parses an event tuple', () => {
    const line = parseAsciiCastLine('[1.25,"o","hello"]')
    expect(line).toEqual([1.25, 'o', 'hello'])
  })

  it('returns null for invalid JSON', () => {
    expect(parseAsciiCastLine('not-json')).toBeNull()
    expect(parseAsciiCastLine('')).toBeNull()
  })

  it('returns null for a header with wrong version', () => {
    expect(parseAsciiCastLine('{"version":1,"width":80,"height":24}')).toBeNull()
  })

  it('returns null for a header missing width/height', () => {
    expect(parseAsciiCastLine('{"version":2,"width":80}')).toBeNull()
  })

  it('returns null for an event with unknown channel', () => {
    expect(parseAsciiCastLine('[1.0,"x","data"]')).toBeNull()
  })

  it('returns null for an event with non-numeric time', () => {
    expect(parseAsciiCastLine('["nope","o","data"]')).toBeNull()
  })

  it('returns null for an event with wrong arity', () => {
    expect(parseAsciiCastLine('[1.0,"o"]')).toBeNull()
  })

  it('returns null for a non-object, non-array top-level value', () => {
    expect(parseAsciiCastLine('42')).toBeNull()
    expect(parseAsciiCastLine('null')).toBeNull()
    expect(parseAsciiCastLine('"string"')).toBeNull()
  })
})

describe('parseRecordingStreamFrame', () => {
  it('parses a start frame', () => {
    expect(parseRecordingStreamFrame('{"start":true,"live":true}'))
      .toEqual({ start: true, live: true })
    expect(parseRecordingStreamFrame('{"start":true,"live":false}'))
      .toEqual({ start: true, live: false })
  })

  it('parses a data frame whose inner AsciiCast is an event', () => {
    expect(parseRecordingStreamFrame('{"data":[0.5,"o","hi"]}'))
      .toEqual({ data: [0.5, 'o', 'hi'] })
  })

  it('parses a data frame whose inner AsciiCast is a header', () => {
    expect(parseRecordingStreamFrame('{"data":{"version":2,"width":80,"height":24}}'))
      .toEqual({ data: { version: 2, width: 80, height: 24 } })
  })

  it('parses an end frame', () => {
    expect(parseRecordingStreamFrame('{"end":true}')).toEqual({ end: true })
  })

  it('returns null for invalid JSON', () => {
    expect(parseRecordingStreamFrame('garbage')).toBeNull()
  })

  it('returns null for a start frame missing live', () => {
    expect(parseRecordingStreamFrame('{"start":true}')).toBeNull()
  })

  it('returns null for a data frame whose inner value is malformed', () => {
    expect(parseRecordingStreamFrame('{"data":[1.0,"x","y"]}')).toBeNull()
    expect(parseRecordingStreamFrame('{"data":{"version":1}}')).toBeNull()
  })

  it('returns null for an unknown frame shape', () => {
    expect(parseRecordingStreamFrame('{"hello":"world"}')).toBeNull()
    expect(parseRecordingStreamFrame('[]')).toBeNull()
  })
})
