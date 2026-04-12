import { TEXT_MODEL } from "../../config/openai.config.js";

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\\s_-]/g, "")
    .replace(/\\s+/g, "_")
}

export async function normalizeComponentRequest({ openai, userMessage, screens }) {
  console.log("[normalizeComponentRequest] raw:", userMessage)

  // All the available screens
  console.log("[normalizeComponentRequest] screens:", (screens || []).map((s) => s.name));

  const screenNames = (screens || []).map((s) => s.name).filter(Boolean)
  const screenFallback = screenNames[0] || "screen"
  const systemPrompt = `
You normalize user requests into a structured UI component spec.

Rules:
- Use ONLY the provided screens list.
- Also detect which screen user want the asset to be part of.
- If user implies a button with an icon, set splitToIcon=true.
- If user explicitly asks for icon only, set iconOnly=true and type="icon".
- Provide a deterministic snake_case name for the asset that is to generated.

Return ONLY valid JSON:
{
  "screenName": "string",
  "type": "button|icon|panel|badge|text|background|indicator|card",
  "name": "string_snake_case",
  "variant": "primary|secondary|ghost|default",
  "size": "small|medium|large",
  "iconOnly": true/false,
  "splitToIcon": true/false
}
`

  const response = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `UserMessage:\n${userMessage}\n\nScreens:\n${screenNames.join(", ")}`
      }
    ],
    response_format: { type: "json_object" }
  })

  const parsed = JSON.parse(response.choices[0].message.content)
  const result = {
    ...parsed,
    screenName: parsed?.screenName || screenFallback,
    name: normalizeName(parsed?.name || "component"),
    variant: parsed?.variant || "default",
    size: parsed?.size || "medium",
    iconOnly: Boolean(parsed?.iconOnly),
    splitToIcon: Boolean(parsed?.splitToIcon)
  }
  console.log("[normalizeComponentRequest] result:", result)
  return result
}
