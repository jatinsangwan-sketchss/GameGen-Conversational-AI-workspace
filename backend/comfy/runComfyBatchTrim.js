import fs from "fs"
import path from "path"
import {
  COMFY_BASE_URL,
  COMFY_OUTPUT_DIR,
  POLL_INTERVAL,
  MAX_WAIT_TIME
} from "./comfyConfig.js"
import { buildWorkflow } from "./buildWorkflow.js"

function collectAssetPaths(session) {
  const assetsByScreen = session?.assets || {}
  const paths = []

  Object.values(assetsByScreen).forEach((screenAssets) => {
    if (!Array.isArray(screenAssets)) return
    screenAssets.forEach((asset) => {
      if (!asset?.path) return
      const absolutePath = path.isAbsolute(asset.path)
        ? asset.path
        : path.join(process.cwd(), asset.path)
      paths.push(absolutePath)
    })
  })

  return paths
}

async function queueComfyWorkflow(imagePaths) {
  const body = buildWorkflow(imagePaths)

  const res = await fetch(`${COMFY_BASE_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Comfy /prompt failed: ${res.status} ${text}`)
  }

  const data = await res.json()
  if (!data?.prompt_id) {
    throw new Error("Comfy did not return prompt_id")
  }

  return data.prompt_id
}

async function waitForComfyCompletion(promptId) {
  const start = Date.now()

  while (Date.now() - start < MAX_WAIT_TIME) {
    const res = await fetch(`${COMFY_BASE_URL}/history/${promptId}`)
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Comfy /history failed: ${res.status} ${text}`)
    }

    const data = await res.json()
    const entry = data?.[promptId]

    if (entry?.status?.completed === true) {
      return true
    }

    if (entry?.outputs && Object.keys(entry.outputs).length > 0) {
      return true
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
  }

  throw new Error("Comfy workflow timed out")
}

function replaceTrimmedAssets(session) {
  const assetsByScreen = session?.assets || {}
  const assets = []
  Object.values(assetsByScreen).forEach((screenAssets) => {
    if (!Array.isArray(screenAssets)) return
    screenAssets.forEach((asset) => assets.push(asset))
  })

  if (!assets.length) {
    console.log("[comfy] No assets to replace")
    return
  }

  if (!fs.existsSync(COMFY_OUTPUT_DIR)) {
    throw new Error(`Comfy output directory not found: ${COMFY_OUTPUT_DIR}`)
  }

  const outputFiles = fs.readdirSync(COMFY_OUTPUT_DIR)
  const outputMap = new Map()

  outputFiles.forEach((file) => {
    const match = file.match(/^(.*)_\d+\.png$/i)
    if (!match) return
    const baseName = `${match[1]}.png`
    const fullPath = path.join(COMFY_OUTPUT_DIR, file)
    const stats = fs.statSync(fullPath)
    const current = outputMap.get(baseName)
    if (!current || stats.mtimeMs > current.mtimeMs) {
      outputMap.set(baseName, { path: fullPath, mtimeMs: stats.mtimeMs })
    }
  })

  assets.forEach((asset) => {
    if (!asset?.fileName || !asset?.path) return
    const output = outputMap.get(asset.fileName)
    if (!output) return

    const originalPath = path.isAbsolute(asset.path)
      ? asset.path
      : path.join(process.cwd(), asset.path)

    fs.copyFileSync(output.path, originalPath)
    fs.unlinkSync(output.path)
  })
}

export async function runComfyBatchTrim(session) {
  const imagePaths = collectAssetPaths(session)

  if (!imagePaths.length) {
    console.log("[comfy] No assets to trim")
    return
  }

  const existingPaths = imagePaths.filter((p) => fs.existsSync(p))
  if (!existingPaths.length) {
    console.log("[comfy] No asset files found on disk")
    return
  }

  console.log(`[comfy] Queuing ${existingPaths.length} assets for trim`)
  const promptId = await queueComfyWorkflow(existingPaths)
  console.log(`[comfy] Prompt queued: ${promptId}`)

  await waitForComfyCompletion(promptId)
  console.log("[comfy] Workflow complete, replacing assets")

  replaceTrimmedAssets(session)
  console.log("[comfy] Asset replacement complete")
}

export { queueComfyWorkflow, waitForComfyCompletion, replaceTrimmedAssets }