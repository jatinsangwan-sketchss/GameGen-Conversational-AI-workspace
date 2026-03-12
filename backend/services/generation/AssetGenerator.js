import { IMAGE_MODEL } from "../../config/openai.config.js"
import {
  getAssetFilePath,
  getAssetRelativePath,
  getScreenFolderName
} from "../storage/AssetPathResolver.js"
import { writeBuffer } from "../storage/FileStorageService.js"

export async function generateAsset({
  openai,
  component,
  screenName,
  designContext,
  gameName,
  screenImagePath
}) {
  const prompt = `
Generate a transparent PNG UI asset.

Design System:
${designContext}

Screen Mockup Reference:
${screenImagePath || "none"}

Asset Type: ${component.type}
Label: ${component.label || ""}
Variant: ${component.variant || "default"}

Requirements:
- Transparent background
- Centered asset 
- Clean edges
- No layout
- Game-ready sprite
`

  const result = await openai.images.generate({
    model: IMAGE_MODEL,
    prompt,
    size: "1024x1024",
    background: "transparent"
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
      const asset = await generateAsset({
        openai,
        component,
        screenName: screen.name,
        designContext: session.designContext,
        gameName: session.gameName,
        screenImagePath: screen.image
      })

      screenAssets.push(asset)
    }

    assets[screen.name] = screenAssets
  }

  console.log("assets::::", assets)
  session.assets = assets
  await runComfyBatchTrim(session)

  return { assets, screens: session.screensMetadata }
}
