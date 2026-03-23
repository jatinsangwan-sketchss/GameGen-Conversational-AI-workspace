import { TEXT_MODEL } from "../../config/openai.config.js"

export async function extractScreensFromPRD({ openai, prdText }) {
  // Strict schema to drive deterministic asset generation prompts
  const systemPrompt = `
You are a production-level mobile game UI component extractor.

STRICT RULES:
- Use ONLY screens and UI elements explicitly described in the PRD. Do not invent.
- Do NOT add new screens or components that are not mentioned.
- Every screen must have a unique snake_case name.
- Every component name must be snake_case and unique within its screen.
- Prefer exact nouns used in the PRD for naming (normalize to snake_case).
- Do NOT include layout or position info.
- If a label is not stated, set label to null.
- If a variant is not stated, set variant to null.
- If type is ambiguous, choose the closest type from:
  button, icon, panel, background, indicator, grid, text, card, badge.

TEXT STRATEGY (critical):
- If the component is text-heavy (labels like "PLAY", "3x3", "4x4", "5x5", "START"),
  then set:
  - label: null
  - text_strategy: "render_text_in_engine"
  - name should be a shell (e.g. btn_grid_chip_unselected, btn_play_shell)
  - must_not_include must contain "no text"
- If the component is not text-heavy, set text_strategy: "render_text_in_asset"

COMPOSITION RULE (critical):
- If the PRD describes a button WITH an icon/gear/settings/symbol inside it:
  - Split into TWO components:
    1) button container with composition_rule "container_only"
    2) icon with composition_rule "icon_only"
- Containers must NEVER include icons.
- Icons must NEVER include containers.

Each component must include:
- type
- name
- label
- variant
- purpose
- visual_style
- shape
- material
- colors
- must_include (array)
- must_not_include (array)
- text_strategy

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
          "variant": "string_or_null",
          "purpose": "string",
          "visual_style": "string",
          "shape": "string",
          "material": "string",
          "colors": "string",
          "must_include": ["string"],
          "must_not_include": ["string"],
          "text_strategy": "render_text_in_engine|render_text_in_asset",
          "composition_rule": "container_only|icon_only|none"
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

  const parsed = JSON.parse(response.choices[0].message.content)

  const normalized = normalizeComposition(parsed)
  const screenCount = Array.isArray(parsed?.screens) ? parsed.screens.length : 0
  const componentCount = Array.isArray(parsed?.screens)
    ? parsed.screens.reduce((sum, screen) => sum + (screen.components?.length || 0), 0)
    : 0
  console.log(`[extractScreensFromPRD] screens=${screenCount} components=${componentCount}`)
  return normalized
}

function normalizeComposition(parsed) {
  const screens = Array.isArray(parsed?.screens) ? parsed.screens : []
  return {
    screens: screens.map((screen) => ({
      ...screen,
      components: splitComposedButtons(screen.components || [])
    }))
  }
}

function splitComposedButtons(components) {
  const keywords = ["icon", "gear", "settings", "symbol", "glyph"]
  const next = []

  components.forEach((component) => {
    const type = String(component.type || "").toLowerCase()
    const combinedText = [
      component.name,
      component.label,
      component.purpose,
      component.visual_style
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()

    const hasIconHint = keywords.some((word) => combinedText.includes(word))

    if (type === "button" && hasIconHint) {
      const base = String(component.name || "button").replace(/_icon|_gear|_settings|_symbol|_glyph/g, "")
      const containerName = base.startsWith("btn_") ? `${base}_container` : `btn_${base}_container`
      const iconName = base.includes("settings")
        ? "icon_settings_gear"
        : base.startsWith("btn_")
          ? base.replace(/^btn_/, "icon_")
          : `icon_${base}`

      next.push({
        ...component,
        name: containerName,
        composition_rule: "container_only",
        must_not_include: [
          ...(component.must_not_include || []),
          "no icon",
          "no embedded symbols"
        ]
      })
      next.push({
        type: "icon",
        name: iconName,
        label: null,
        variant: component.variant || null,
        purpose: "icon for " + (component.purpose || component.name || "button"),
        visual_style: component.visual_style || "icon",
        shape: "icon",
        material: "flat",
        colors: component.colors || "inherit",
        must_include: ["one standalone icon"],
        must_not_include: ["no background shape", "no button container"],
        text_strategy: "render_text_in_asset",
        composition_rule: "icon_only"
      })
      return
    }

    next.push({
      ...component,
      composition_rule: component.composition_rule || "none"
    })
  })

  return next
}
