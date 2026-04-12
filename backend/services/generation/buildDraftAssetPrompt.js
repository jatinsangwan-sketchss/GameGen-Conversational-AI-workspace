function formatTokens(tokens = {}) {
  return `
Design Tokens:
- borderRadius: ${tokens.borderRadius ?? "unknown"}
- accentColor: ${tokens.accentColor ?? "unknown"}
- buttonHeight: ${tokens.buttonHeight ?? "unknown"}
- glowStyle: ${tokens.glowStyle ?? "unknown"}
- shadowStyle: ${tokens.shadowStyle ?? "unknown"}
`
}

function formatAssets(assets = []) {
  if (!assets.length) return "Existing Screen Assets: none"
  const lines = assets.map((asset) => `- ${asset.id || asset.fileName || asset.path}`)
  return `Existing Screen Assets:\n${lines.join("\n")}`
}

export function buildDraftAssetPrompt({
  designContext,
  designTokens,
  existingScreenAssets,
  componentSpec,
  screenName
}) {
  return `
Generate exactly one isolated mobile game UI asset as a transparent PNG.

Design System:
${designContext || "unknown"}

${formatTokens(designTokens)}

Screen:
${screenName}

Component Spec:
- type: ${componentSpec.type}
- name: ${componentSpec.name}
- variant: ${componentSpec.variant || "default"}
- size: ${componentSpec.size || "medium"}

${formatAssets(existingScreenAssets)}

Strict Requirements:
- match the existing screen's visual system and theme
- transparent background
- centered asset
- no text
- no layout
- no scene
- no extra UI
- output as a single PNG sprite
`
}
