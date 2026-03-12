import path from "path"
import { buildAssetDir, normalizeScreenFolder } from "../../utils/pathUtils.js"

export function getScreenFolderName(screenName) {
  return normalizeScreenFolder(screenName)
}

export function getScreenAssetDir(gameName, screenName) {
  return buildAssetDir(gameName, screenName)
}

export function getAssetFilePath(gameName, screenName, fileName) {
  return path.join(getScreenAssetDir(gameName, screenName), fileName)
}

export function getAssetRelativePath(gameName, screenName, fileName) {
  return `assets/${gameName}/${getScreenFolderName(screenName)}/${fileName}`
}

export function getScreenMockupFileName() {
  return "screen_mockup.png"
}

export function getScreenMockupPath(gameName, screenName) {
  return getAssetFilePath(gameName, screenName, getScreenMockupFileName())
}
