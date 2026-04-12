import { TEXT_MODEL } from "../../config/openai.config.js"

export async function classifyIntent({ openai, message, session }) {
  const hasExistingScreens = session?.screensMetadata?.length > 0
  const safeMessage = typeof message === "string" ? message : ""

  const systemPrompt = `
You are an intent classifier for a conversational UI asset generation system and you are provided with human messages, provide me with the
correct intent from the available intents

Available intents:
- NEW_PRD
- ADD_COMPONENT
- UPDATE_DESIGN
- SMALL_TALK
- UNKNOWN

Session State:
hasExistingScreens: ${hasExistingScreens}

Context Rules:

1. If there are NO existing screens and user provides structured UI description → NEW_PRD.
2. If user says change theme, color, style → UPDATE_DESIGN.
3. If user asks to add a button/icon/component to an existing screen → ADD_COMPONENT.
4. Greetings or irrelevant text → SMALL_TALK.
5. Otherwise → UNKNOWN.


Return ONLY valid JSON:
{
  "intent": "NEW_PRD | ADD_COMPONENT | UPDATE_DESIGN | SMALL_TALK | UNKNOWN"
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
