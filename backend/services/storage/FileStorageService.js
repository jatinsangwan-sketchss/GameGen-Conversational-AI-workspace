import fs from "fs"
import path from "path"
import {
  getAssetRelativePath,
  getScreenMockupFileName,
  getScreenMockupPath
} from "./AssetPathResolver.js"

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

export function writeBuffer(filePath, buffer) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, buffer)
  return filePath
}

export async function saveImageSourceToPath(imageSource, filePath) {
  if (!imageSource) return null

  if (imageSource.startsWith("data:")) {
    const base64 = imageSource.split(",")[1]
    const buffer = Buffer.from(base64, "base64")
    return writeBuffer(filePath, buffer)
  }

  if (imageSource.startsWith("http://") || imageSource.startsWith("https://")) {
    const res = await fetch(imageSource)
    if (!res.ok) {
      throw new Error(`Failed to fetch image: ${res.status}`)
    }
    const arrayBuffer = await res.arrayBuffer()
    return writeBuffer(filePath, Buffer.from(arrayBuffer))
  }

  return imageSource
}

export async function saveScreenMockup(imageSource, gameName, screenName) {
  const filePath = getScreenMockupPath(gameName, screenName)
  const saved = await saveImageSourceToPath(imageSource, filePath)
  if (!saved) return null
  return getAssetRelativePath(gameName, screenName, getScreenMockupFileName())
}
