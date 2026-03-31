import { EventEmitter } from "events"

const buildSessions = new Map()

function createSession(sessionId) {
  return {
    sessionId,
    status: "idle",
    logs: [],
    blueprintHistory: [],
    buildHistory: [],
    latestBlueprint: null,
    assets: null,
    layouts: null,
    blueprint: null,
    emitter: new EventEmitter()
  }
}

export function getBuildSession(sessionId = "default") {
  if (!buildSessions.has(sessionId)) {
    buildSessions.set(sessionId, createSession(sessionId))
  }
  return buildSessions.get(sessionId)
}

export function appendBuildLog(sessionId, level, message) {
  const session = getBuildSession(sessionId)
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message
  }
  session.logs.push(payload)
  session.emitter.emit("log", payload)
  return payload
}

export function updateBuildStatus(sessionId, status) {
  const session = getBuildSession(sessionId)
  session.status = status
  session.emitter.emit("status", { status })
  return session.status
}

export function recordBlueprint(sessionId, blueprint) {
  const session = getBuildSession(sessionId)
  session.latestBlueprint = blueprint
  session.blueprint = blueprint
  session.blueprintHistory.push({
    createdAt: new Date().toISOString(),
    blueprint
  })
}

export function setBuildContext(sessionId, { assets, layouts }) {
  const session = getBuildSession(sessionId)
  session.assets = assets
  session.layouts = layouts
}

export function recordBuildRun(sessionId, blueprint) {
  const session = getBuildSession(sessionId)
  session.buildHistory.push({
    startedAt: new Date().toISOString(),
    blueprint
  })
}

export function getBuildLogs(sessionId) {
  const session = getBuildSession(sessionId)
  return session.logs
}
