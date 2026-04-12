import { TEXT_MODEL } from "../../config/openai.config.js"
import { appendSummaryChunk, clearSummary } from "./AssetSummaryStore.js"

const SUMMARY_SYSTEM_PROMPT = `
You write short UX status summaries for asset generation.
Rules:
- Keep each line under 12 words.
- No reasoning.
- Mention style matching briefly.
- Output 4-6 short lines, each on a new line.
`

export async function streamAssetSummary({
  openai,
  sessionId,
  componentSpec,
  screenName,
  designContext,
  designTokens
}) {
  clearSummary(sessionId)

  const prompt = `
Component:
${JSON.stringify(componentSpec)}

Screen:
${screenName}

DesignContext:
${designContext}

DesignTokens:
${JSON.stringify(designTokens)}
`

  const response = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: prompt }
    ],
    stream: true
  })

  let buffer = ""
  for await (const chunk of response) {
    const delta = chunk.choices?.[0]?.delta?.content || ""
    if (!delta) continue
    buffer += delta
    if (buffer.includes("\n")) {
      const parts = buffer.split("\n")
      buffer = parts.pop() || ""
      parts.forEach((line) => {
        const trimmed = line.trim()
        if (trimmed) appendSummaryChunk(sessionId, trimmed, false)
      })
    }
  }

  const final = buffer.trim()
  if (final) appendSummaryChunk(sessionId, final, true)
  appendSummaryChunk(sessionId, `Draft ${componentSpec.name} generated for ${screenName}.`, true)
}
