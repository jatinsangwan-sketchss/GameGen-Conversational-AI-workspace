import { TEXT_MODEL } from "../../config/openai.config.js"

export async function classifyIntent({ openai, message, session }) {
  const hasExistingScreens = session?.screensMetadata?.length > 0
  const safeMessage = typeof message === "string" ? message : ""

  const systemPrompt = `
You are an intent classifier for a conversational UI design system.

Available intents:
- NEW_PRD
- ADD_SCREEN
- UPDATE_DESIGN
- REGENERATE_ALL
- SMALL_TALK
- UNKNOWN

Context Rules:

1. If there are NO existing screens and user provides structured UI description → NEW_PRD.
2. If there ARE existing screens and user says "add" one new screen → ADD_SCREEN.
3. If user says change theme, color, style → UPDATE_DESIGN.
4. If user says regenerate screens → REGENERATE_ALL.
5. If user asks to generate or export assets, PNGs, sprites, UI assets → GENERATE_ASSETS.
6. Greetings or irrelevant text → SMALL_TALK.
7. Otherwise → UNKNOWN.

Session State:
hasExistingScreens: ${hasExistingScreens}

Return ONLY valid JSON:
{
  "intent": "NEW_PRD | ADD_SCREEN | UPDATE_DESIGN | REGENERATE_ALL | GENERATE_ASSETS | SMALL_TALK | UNKNOWN"
}
`

  const response = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: safeMessage }
    ],
    response_format: { type: "json_object" }
  })

  return JSON.parse(response.choices[0].message.content)
}
