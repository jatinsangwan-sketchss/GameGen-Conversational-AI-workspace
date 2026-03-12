import fs from "fs"
import path from "path"

/**
 * Recursively collect all PNG file paths from a root folder
 * @param {string} rootDir - Absolute path to assets folder
 * @returns {string[]} Array of absolute PNG file paths
 */
export function collectPngPaths(rootDir) {
  const pngFiles = []

  if (!fs.existsSync(rootDir)) {
    throw new Error(`Directory does not exist: ${rootDir}`)
  }

  function scanDirectory(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        scanDirectory(fullPath)
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".png") &&
        !entry.name.startsWith(".")
      ) {
        pngFiles.push(fullPath)
      }
    }
  }

  scanDirectory(rootDir)

  return pngFiles
}
