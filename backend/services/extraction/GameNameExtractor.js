import { TEXT_MODEL } from "../../config/openai.config.js"

export async function extractGameNameFromPRD({ openai, prdText }) {
  const systemPrompt = `
Extract the game name from the PRD.
Rules:
- Use ONLY the name explicitly stated in the PRD.
- Return only the name in lowercase snake_case (no extra text).
- If none found, return "game_ui".
  `

  const response = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prdText }
    ]
  })

  return response.choices[0].message.content.trim().replace(/\s+/g, "_")
}
