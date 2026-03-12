import { TEXT_MODEL } from "../../config/openai.config.js"

export function stripLayoutFromScreens(screens) {
  return (screens || []).map((screen) => ({
    name: screen.name,
    description: screen.description,
    components: (screen.components || []).map((component) => ({
      type: component.type,
      name: component.name,
      label: component.label || null,
      variant: component.variant || null
    }))
  }))
}

export async function generateLayoutFromTrimmedAssets({ openai, session }) {
  const systemPrompt = `
You are a production-level mobile game UI layout engine.

You are given:
- Design context
- Screens with components (no layout yet)
- Trimmed asset metadata grouped by screen

Task:
Return the same screens with layout metadata for every component.

-------------------------------------
LAYOUT RULES (VERY IMPORTANT)
-------------------------------------
All layout values must be NORMALIZED between 0 and 1.

layout object must include:
{
  "x": number (0-1 horizontal center),
  "y": number (0-1 vertical center),
  "width": number (0-1 relative to screen width),
  "height": number (0-1 relative to screen height),
  "zIndex": integer,
  "anchor": "center"
}

Rules:
- 0 = left/top
- 1 = right/bottom
- Do NOT use pixels
- Do NOT use percentages
- Background should be full screen (width:1, height:1, x:0.5, y:0.5)
- zIndex controls stacking (background lowest)
- UI must be visually logical and production-ready
- Use asset file names and component labels as hints
- Do NOT add or remove components
- No animation
- No layout hints outside layout object

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
          "variant": "string_or_null",
          "layout": {
            "x": 0,
            "y": 0,
            "width": 0,
            "height": 0,
            "zIndex": 0,
            "anchor": "center"
          }
        }
      ]
    }
  ]
}
`

  const payload = {
    designContext: session.designContext,
    screens: stripLayoutFromScreens(session.screensMetadata),
    assets: session.assets
  }

  const response = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(payload) }
    ],
    response_format: { type: "json_object" }
  })

  const parsed = JSON.parse(response.choices[0].message.content)
  if (!parsed?.screens) {
    return session.screensMetadata || []
  }

  return parsed.screens
}
