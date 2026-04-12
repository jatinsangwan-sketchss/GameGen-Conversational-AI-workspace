import { IMAGE_MODEL } from "../../config/openai.config.js"
import path from "path"
import fs from "fs"
import { writeBuffer } from "../storage/FileStorageService.js"

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
}

function buildDraftDir(gameName, screenName) {
  const safeGame = normalizeName(gameName || "game_ui")
  const safeScreen = normalizeName(screenName || "screen")
  return path.join(process.cwd(), "assets", "_drafts", safeGame, safeScreen)
}

export function buildFinalDir(gameName, screenName) {
  const safeGame = normalizeName(gameName || "game_ui")
  const safeScreen = normalizeName(screenName || "screen")
  return path.join(process.cwd(), "assets", safeGame, safeScreen)
}

export async function generateDraftAsset({ openai, prompt, componentSpec, gameName, screenName }) {
  console.log("[generateDraftAsset] start", {
    screenName,
    component: componentSpec?.name,
    variant: componentSpec?.variant,
    type: componentSpec?.type
  })
  const result = await openai.images.generate({
    model: IMAGE_MODEL,
    prompt,
    size: "1024x1024",
    background: "transparent"
  })

  const image = result.data?.[0]
  if (!image?.b64_json) throw new Error("Draft asset generation failed")

  const buffer = Buffer.from(image.b64_json, "base64")
  const draftDir = buildDraftDir(gameName, screenName)
  fs.mkdirSync(draftDir, { recursive: true })

  const fileName = `${normalizeName(componentSpec.name)}_${componentSpec.variant || "default"}_draft.png`
  const filePath = path.join(draftDir, fileName)
  writeBuffer(filePath, buffer)
  console.log("[generateDraftAsset] saved", { filePath })

  return {
    id: `${normalizeName(screenName)}_${normalizeName(componentSpec.name)}_draft`,
    screenName,
    fileName,
    path: path.relative(process.cwd(), filePath),
    status: "pending",
    createdAt: new Date().toISOString()
  }
}

