import { IMAGE_MODEL } from "../../config/openai.config.js"
import {
  getAssetFilePath,
  getAssetRelativePath,
  getScreenFolderName
} from "../storage/AssetPathResolver.js"
import { writeBuffer } from "../storage/FileStorageService.js"

function buildBackgroundPrompt({ gameName, screenName, designContext }) {
  return `
Generate one full-screen mobile game background.

Game:
${gameName}

Design System:
${designContext}

Screen:
${screenName}

Requirements:
- 9:16 vertical composition
- full-frame background
- no transparency
- no UI
- no buttons
- no text
- no logos
- same visual theme as other screens
- soft gradient sky with clouds and sparkles
- clean center space for UI placement
`
}

function buildAssetPrompt({ gameName, screenName, designContext, component }) {
  const mustInclude = (component.must_include || []).map((item) => `- ${item}`).join("\n")
  const mustNotInclude = (component.must_not_include || []).map((item) => `- ${item}`).join("\n")
  const textRule =
    component.text_strategy === "render_text_in_engine"
      ? "- no text\n- no numbers\n- leave empty text-safe area"
      : ""
  const compositionRule = component.composition_rule || "none"
  const compositionHardRules =
    compositionRule === "container_only"
      ? `- this asset is a container ONLY
- do NOT include any icon inside
- keep center empty for icon placement
- no embedded symbols`
      : compositionRule === "icon_only"
        ? `- this asset is an icon ONLY
- do NOT include any background shape
- do NOT include button container
- no circular or rectangular base`
        : ""

  return `
Generate exactly one isolated mobile game UI asset as a transparent PNG.

Game:
${gameName}

Design System:
${designContext}

Screen:
${screenName}

Asset Name:
${component.name}

Asset Type:
${component.type}

Label:
${component.label || "none"}

Variant:
${component.variant || "default"}

Purpose:
${component.purpose || "unknown"}

Visual Style:
${component.visual_style || "unknown"}

Shape:
${component.shape || "unknown"}

Material:
${component.material || "unknown"}

Colors:
${component.colors || "unknown"}

Must Include:
${mustInclude || "- none"}

Must Not Include:
${mustNotInclude || "- none"}

Composition Rule:
${compositionRule}

Hard Rules:
- generate exactly one asset only
- centered composition
- transparent background
- no layout
- no scene
- no duplicates
- no extra UI
- no watermark
- no mockup frame
- game-ready sprite
- no combined UI elements
- no mixing container and icon
${textRule}
${compositionHardRules}
`
}

export async function generateAsset({
  openai,
  component,
  screenName,
  designContext,
  gameName
}) {
  // Backgrounds require full 9:16 frame and no transparency
  const isBackground = String(component.type || "").toLowerCase() === "background"
  const prompt = isBackground
    ? buildBackgroundPrompt({ gameName, screenName, designContext })
    : buildAssetPrompt({ gameName, screenName, designContext, component })

  const result = await openai.images.generate({
    model: IMAGE_MODEL,
    prompt,
    size: isBackground ? "1024x1536" : "1024x1024",
    ...(isBackground ? {} : { background: "transparent" })
  })

  const image = result.data?.[0]
  if (!image?.b64_json) throw new Error("Asset generation failed")

  const buffer = Buffer.from(image.b64_json, "base64")
                                 
  const fileName = `${component.name}_${component.variant || "default"}.png`
  const screenFolder = getScreenFolderName(screenName)
  const filePath = getAssetFilePath(gameName, screenName, fileName)
  writeBuffer(filePath, buffer)

  return {
    id: `${screenFolder}_${component.name}`,
    type: component.type,
    label: component.label || null,
    fileName,
    path: getAssetRelativePath(gameName, screenName, fileName)
  }
}

export async function generateAssetsForSession({ openai, session, runComfyBatchTrim }) {
  const assets = {}

  for (const screen of session.screensMetadata) {
    const screenAssets = []

    for (const component of screen.components) {
      console.log("[generateAsset]", {
        screen: screen.name,
        component: component.name,
        type: component.type,
        variant: component.variant,
        text_strategy: component.text_strategy,
        composition_rule: component.composition_rule
      })
      const asset = await generateAsset({
        openai,
        component,
        screenName: screen.name,
        designContext: session.designContext,
        gameName: session.gameName
      })

      screenAssets.push(asset)
    }

    assets[screen.name] = screenAssets
  }

  console.log("assets::::", assets)
  session.assets = assets
  session.lastAssetGenerationAt = new Date().toISOString()
  await runComfyBatchTrim(session)

  return { assets, screens: session.screensMetadata }
}
