import { EventEmitter } from "events"

const summarySessions = new Map()

function createSummarySession(sessionId) {
  return {
    sessionId,
    chunks: [],
    emitter: new EventEmitter()
  }
}

export function getSummarySession(sessionId = "default") {
  if (!summarySessions.has(sessionId)) {
    summarySessions.set(sessionId, createSummarySession(sessionId))
  }
  return summarySessions.get(sessionId)
}

export function clearSummary(sessionId) {
  const session = getSummarySession(sessionId)
  session.chunks = []
}

export function appendSummaryChunk(sessionId, chunk, isFinal = false) {
  const session = getSummarySession(sessionId)
  const payload = {
    timestamp: new Date().toISOString(),
    chunk,
    final: Boolean(isFinal)
  }
  session.chunks.push(payload)
  session.emitter.emit("summary", payload)
  return payload
}

export function getSummaryChunks(sessionId) {
  const session = getSummarySession(sessionId)
  return session.chunks
}
