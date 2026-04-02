import { getSession } from "../../sessions.js"
import { buildLayoutFilePath, readLayoutFile } from "../../utils/layoutStorage.js"
import path from "path"
import {
  recordBlueprint,
  appendBuildLog,
  appendReasoningChunk,
  setBuildContext
} from "./GameBuildStore.js"

function normalizeName(value) {
  return String(value || "game_ui")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
}

function buildAssetManifest(assets = {}) {
  const entries = []
  Object.entries(assets).forEach(([screenName, screenAssets]) => {
    if (!Array.isArray(screenAssets)) return
    screenAssets.forEach((asset) => {
      if (!asset?.path) return
      entries.push({
        screenName,
        id: asset.id,
        fileName: asset.fileName || path.basename(asset.path),
        path: asset.path,
        type: asset.type || "asset"
      })
    })
  })
  return entries
}

function buildSceneBlueprint({ screens = [], gameName, assets, layouts }) {
  return screens.map((screen) => ({
    name: screen.name,
    description: screen.description || "",
    layoutPath: buildLayoutFilePath(gameName, screen.name),
    layout: layouts[screen.name] || null,
    assets: assets.filter((asset) => asset.screenName === screen.name),
    scriptModules: [
      {
        name: `${normalizeName(screen.name)}_scene_controller`,
        purpose: "Handle scene-specific UI logic and input."
      }
    ]
  }))
}

function emitReasoning(sessionId, text) {
  const chunks = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  chunks.forEach((chunk) => appendReasoningChunk(sessionId, chunk))
}

export function generateGameBlueprint({ sessionId, prdText }) {
  const session = getSession(sessionId)
  const gameName = session?.gameName || "game_ui"
  const screens = session?.screensMetadata || []
  const assets = buildAssetManifest(session?.assets || {})

  emitReasoning(sessionId, "Analyzing gameplay PRD for scenes, mechanics, and rules.")
  emitReasoning(sessionId, `Detected ${screens.length} UI screen(s) in session.`)
  emitReasoning(sessionId, `Located ${assets.length} asset(s) across screens.`)

  const layouts = {}
  screens.forEach((screen) => {
    layouts[screen.name] = readLayoutFile(gameName, screen.name)
    if (!layouts[screen.name]) {
      emitReasoning(sessionId, `No layout JSON found for ${screen.name}.`)
    } else {
      emitReasoning(sessionId, `Loaded layout JSON for ${screen.name}.`)
    }
  })

  const blueprint = {
    version: 1,
    gameName,
    createdAt: new Date().toISOString(),
    prdText,
    scenes: buildSceneBlueprint({ screens, gameName, assets, layouts }),
    assets,
    layouts: Object.fromEntries(
      screens.map((screen) => [
        screen.name,
        {
          path: buildLayoutFilePath(gameName, screen.name),
          data: layouts[screen.name]
        }
      ])
    ),
    scripts: [
      {
        name: "game_state_manager",
        purpose: "Global game state and navigation flow."
      }
    ],
    autoloads: [
      {
        name: "GameState",
        script: "game_state_manager"
      }
    ]
  }

  recordBlueprint(sessionId, blueprint)
  setBuildContext(sessionId, { assets, layouts })
  appendBuildLog(sessionId, "INFO", "Generating Game Blueprint...")

  emitReasoning(sessionId, "Blueprint assembled. Awaiting HITL confirmation.")

  return blueprint
}
