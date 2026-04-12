import { TEXT_MODEL } from "../../config/openai.config.js"

// Normalize here refers to the - adjusting the values to not break at the 
function normalizeTokens(raw) {
  const borderRadius = Number(raw?.borderRadius)
  const buttonHeight = Number(raw?.buttonHeight)
  return {
    borderRadius: Number.isFinite(borderRadius) ? borderRadius : 12,
    accentColor: raw?.accentColor || "unknown",
    buttonHeight: Number.isFinite(buttonHeight) ? buttonHeight : 84,
    glowStyle: raw?.glowStyle || "unknown",
    shadowStyle: raw?.shadowStyle || "unknown"
  }
}

export async function extractDesignTokens({ openai, prdText, designContext }) {
  const systemPrompt = `
You extract UI design tokens for a game UI system and will be used later as context for generating new assets.

Rules:
- Use PRD first; use design context only to choose sensible defaults.
- Return a JSON object with EXACT keys:
  borderRadius (number),
  accentColor (string),
  buttonHeight (number),
  glowStyle (string),
  shadowStyle (string).
- If unsure, choose safe defaults that fit the design context.
`

  const response = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `PRD:\n${prdText}\n\nDesignContext:\n${designContext || "unknown"}`
      }
    ],
    response_format: { type: "json_object" }
  })

  const parsed = JSON.parse(response.choices[0].message.content)
  return normalizeTokens(parsed)
}
