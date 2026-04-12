import { getSummarySession, getSummaryChunks } from "./AssetSummaryStore.js"

export function handleAssetSummaryStream(req, res) {
  const sessionId = req.query.sessionId || "default"
  const summarySession = getSummarySession(sessionId)

  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  res.flushHeaders?.()

  const existing = getSummaryChunks(sessionId)
  existing.forEach((payload) => {
    res.write(`event: summary\ndata: ${JSON.stringify(payload)}\n\n`)
  })

  const onSummary = (payload) => {
    res.write(`event: summary\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  summarySession.emitter.on("summary", onSummary)

  req.on("close", () => {
    summarySession.emitter.off("summary", onSummary)
    res.end()
  })
}
