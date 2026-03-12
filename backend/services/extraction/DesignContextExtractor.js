import { TEXT_MODEL } from "../../config/openai.config.js"

export async function extractDesignContext({ openai, prdText }) {
  const systemPrompt = `
You are a design system extractor.

From the PRD, extract:
- App identity
- Theme (light/dark)
- Primary color
- Accent style
- Typography vibe
- Overall design vibe

Return ONLY clean text summary.
`

  const response = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0,  // should I make the temperature 0 in order to always have the same result whenever the same PRD is feed
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prdText }
    ]
  })

  return response.choices[0].message.content.trim()
}
