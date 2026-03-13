import { TEXT_MODEL } from "../../config/openai.config.js"

export async function extractScreensFromPRD({ openai, prdText }) {
  const systemPrompt = `
You are a production-level mobile game UI screen extractor.

Rules (strict):
- Use ONLY screens and UI elements explicitly described in the PRD.
- Do NOT add new screens or components that are not mentioned.
- Every screen must have a unique snake_case name.
- Every component name must be snake_case and unique within its screen.
- Prefer the exact nouns used in the PRD for naming (normalize to snake_case).
- If a label is not stated, set label to null.
- If a variant is not stated, set variant to null.
- If type is ambiguous, choose the closest type from: button, icon, panel, background, indicator, grid, text, card, badge.
- Do not include layout or position info.

Return ONLY valid JSON matching this schema:
{
  "screens": [
    {
      "name": "string",
      "description": "string",
      "components": [
        {
          "type": "string",
          "name": "string_snake_case",
          "label": "string_or_null",
          "variant": "string_or_null"
        }
      ]
    }
  ]
}
`

  const response = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prdText }
    ],
    response_format: { type: "json_object" }
  })

  return JSON.parse(response.choices[0].message.content)
}
