import fs from "fs"
import path from "path"
import { File } from "node:buffer"
import { IMAGE_MODEL } from "../config/openai.config.js"
import { runComfyTrimSingle } from "./comfy/ComfyOrchestrator.js"

const STRICT_EDIT_PROMPT = (designContext, instruction) => `
You are editing an existing game UI asset.

STRICT RULES:
- Preserve original shape
- Preserve proportions
- Preserve typography
- Preserve layout
- Do not resize element
- Do not add new UI elements
- background should be transparent
- Only apply the requested visual modification

Design System:
${designContext}

User request:
${instruction}
`

function resolveAbsolutePath(assetPath) {
  if (path.isAbsolute(assetPath)) return assetPath
  return path.join(process.cwd(), assetPath)
}

function ensureOriginalBackup(assetAbsolutePath) {
  const dir = path.dirname(assetAbsolutePath)
  const fileName = path.basename(assetAbsolutePath)
  const originalDir = path.join(dir, "_original")
  const originalPath = path.join(originalDir, fileName)

  if (!fs.existsSync(originalDir)) {
    fs.mkdirSync(originalDir, { recursive: true })
  }
  if (!fs.existsSync(originalPath)) {
    fs.copyFileSync(assetAbsolutePath, originalPath)
  }
  return originalPath
}

export async function editAsset({ openai, assetPath, instruction, designContext }) {
  if (!assetPath || !instruction || !designContext) {
    throw new Error("assetPath, instruction, and designContext are required")
  }

  const assetAbsolutePath = resolveAbsolutePath(assetPath)
  if (!fs.existsSync(assetAbsolutePath)) {
    throw new Error(`Asset file not found: ${assetAbsolutePath}`)
  }

  const originalPath = ensureOriginalBackup(assetAbsolutePath)
  const originalBuffer = fs.readFileSync(originalPath)
  const originalFile = new File([originalBuffer], path.basename(originalPath), {
    type: "image/png"
  })

  const prompt = STRICT_EDIT_PROMPT(designContext, instruction)

  const result = await openai.images.edit({
    model: IMAGE_MODEL,
    image: originalFile,
    prompt,
    n: 1,
    size: "1024x1024"
  })

  const image = result.data?.[0]
  if (!image?.b64_json) {
    throw new Error("No edited image returned")
  }

  const buffer = Buffer.from(image.b64_json, "base64")
  fs.writeFileSync(assetAbsolutePath, buffer)

  await runComfyTrimSingle(assetAbsolutePath)

  return assetPath
}
