import { getBuildSession, getBuildLogs, getBuildReasoning } from "./GameBuildStore.js"

export function handleGameBuildStream(req, res) {
  const sessionId = req.query.sessionId || "default"
  const buildSession = getBuildSession(sessionId)

  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  res.flushHeaders?.()

  const existingLogs = getBuildLogs(sessionId)
  existingLogs.forEach((log) => {
    res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`)
  })

  const existingReasoning = getBuildReasoning(sessionId)
  existingReasoning.forEach((reasoning) => {
    res.write(`event: reasoning\ndata: ${JSON.stringify(reasoning)}\n\n`)
  })

  res.write(`event: status\ndata: ${JSON.stringify({ status: buildSession.status })}\n\n`)

  const onLog = (log) => {
    res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`)
  }
  const onStatus = (payload) => {
    res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  const onReasoning = (payload) => {
    res.write(`event: reasoning\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  buildSession.emitter.on("log", onLog)
  buildSession.emitter.on("status", onStatus)
  buildSession.emitter.on("reasoning", onReasoning)

  req.on("close", () => {
    buildSession.emitter.off("log", onLog)
    buildSession.emitter.off("status", onStatus)
    buildSession.emitter.off("reasoning", onReasoning)
    res.end()
  })
}
