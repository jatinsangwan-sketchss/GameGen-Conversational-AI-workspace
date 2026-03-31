import fs from "fs"
import path from "path"

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
}

export function buildLayoutDir(gameName) {
  return path.join(process.cwd(), "layouts", normalizeName(gameName || "game_ui"))
}

export function buildLayoutFilePath(gameName, screenName) {
  const dir = buildLayoutDir(gameName)
  const fileName = `${normalizeName(screenName || "screen")}.json`
  return path.join(dir, fileName)
}

export function saveLayoutFile({ gameName, screenName, elements }) {
  const filePath = buildLayoutFilePath(gameName, screenName)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify({ elements }, null, 2))
  return filePath
}

export function readLayoutFile(gameName, screenName) {
  const filePath = buildLayoutFilePath(gameName, screenName)
  if (!fs.existsSync(filePath)) {
    return null
  }
  const raw = fs.readFileSync(filePath, "utf-8")
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
