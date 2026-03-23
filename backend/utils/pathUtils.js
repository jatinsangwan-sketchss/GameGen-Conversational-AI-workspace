import path from "path"

export function normalizeScreenFolder(screenName) {
  return String(screenName || "screen")
    .toLowerCase()
    .replace(/\s+/g, "_")
}

export function buildAssetDir(gameName, screenName) {
  return path.join(
    process.cwd(),
    "assets",
    gameName || "game_ui",
    normalizeScreenFolder(screenName)
  )
}
