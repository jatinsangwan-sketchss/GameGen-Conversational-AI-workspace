import { TEXT_MODEL } from "../../config/openai.config.js"

export async function extractScreensFromPRD({ openai, prdText }) {
  const systemPrompt = `
You are a production-level mobile game UI planner.

Your job:
From the PRD, extract structured UI screens and components.

For each screen return:

1. name
2. description
3. components (structured list)

-------------------------------------
COMPONENT STRUCTURE
-------------------------------------

Each component must include:

- type (button, icon, panel, background, indicator, grid, text, etc.)
- name (snake_case, unique per screen)
- label (string or null)
- variant (primary, secondary, circular, glass, etc.)

Return ONLY valid JSON.

Output format:

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
    temperature: 0, // again the same doubt with the temperature should I make it 0 to nullify the randomness
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prdText }
    ],
    response_format: { type: "json_object" }
  })

  return JSON.parse(response.choices[0].message.content)
}
