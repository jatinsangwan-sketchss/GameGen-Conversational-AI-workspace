import { TEXT_MODEL } from "../../config/openai.config.js"

export async function extractDesignContext({ openai, prdText }) {
  // Deterministic, fielded design context to reduce guessing
  const systemPrompt = `
You are a design system extractor for a game UI pipeline.

Rules:
- Use ONLY information explicitly stated in the PRD. Do not invent details.
- If a field is missing, write "unknown".
- Keep each field to a single concise line (no extra prose).
- Use lowercase for theme (light/dark/unknown).

Return EXACTLY this format (6 lines, same labels, no extra text):
App identity: <value>
Theme: <light|dark|unknown>
Primary color: <value|unknown>
Accent style: <value|unknown>
Typography vibe: <value|unknown>
Overall design vibe: <value|unknown>
`

  const response = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prdText }
    ]
  })

  return response.choices[0].message.content.trim()
}
