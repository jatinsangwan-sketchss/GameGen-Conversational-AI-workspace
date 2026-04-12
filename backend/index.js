import dotenv from "dotenv"
dotenv.config()

import express from "express"
import cors from "cors"
import path from "path"
import OpenAI from "openai"
import { callAgent } from "./v3LLL-service.js"
import {
  checkSession,
  deleteSession,
  getSession,
  sessions as sessionStore
} from "./sessions.js"
import { saveLayoutFile } from "./utils/layoutStorage.js"
import { editAsset } from "./services/editAssetService.js"
import { generateGameBlueprint } from "./services/gameBuild/GameBlueprintService.js"
import { runGameBuild } from "./services/gameBuild/GameBuildOrchestrator.js"
import { appendBuildLog, updateBuildStatus } from "./services/gameBuild/GameBuildStore.js"
import { handleGameBuildStream } from "./services/gameBuild/GameBuildStream.js"
import { handleAssetSummaryStream } from "./services/summary/AssetSummaryStream.js"
import { addFinalAssetToSession, moveDraftToFinal, regenerateDraft } from "./services/generation/DraftAssetService.js"
import { buildFinalDir } from "./services/generation/DraftAssetGenerator.js"
import fs from "fs"
import { runComfyTrimSingle } from "./services/comfy/ComfyOrchestrator.js"



const app = express()
app.use(cors())
app.use(express.json({ limit: "25mb" }))
app.use("/assets", express.static(path.join(process.cwd(), "assets")))

console.log("OPENAI_API_KEY loaded:", !!process.env.OPENAI_API_KEY)

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

/**
 * Session tracking (lightweight)
 * Actual UI spec memory is handled inside llmService via getSession()
 */


app.post("/api/chat", async (req, res) => {
  try {
    const { message, sessionId = "default" } = req.body

    if (!message) {
      return res.status(400).json({ error: "Message is required" })
    }

    // Call stateful conversational engine
    const response = await callAgent(message, sessionId)
    const session = getSession(sessionId)

    // Persist screens/assets from asset-first service
    if (Array.isArray(response?.screens)) {
      session.screensMetadata = response.screens
    }
    if (response?.assets && typeof response.assets === "object") {
      session.assets = response.assets
    }

    res.json({
      chat: response.chat,
      screens: session.screensMetadata || [],
      assets: session.assets || {},
      designContext: session.designContext || null,
      draftAssets: session.draftAssets || {}
    })

  } catch (error) {
    console.error("Error processing chat:", error)

    res.status(500).json({
      error: "Failed to process chat request",
      chat: "Something went wrong while processing your request.",
      artifacts: []
    })
  }
})


/**
 * Clear session endpoint
 * Clears UI specs stored in memory
 */
app.post("/api/chat/clear", (req, res) => {
  const { sessionId = "default" } = req.body
  deleteSession(sessionId)
  res.json({ success: true, message: `Session ${sessionId} cleared` })
})

/**
 * Annotate asset edit endpoint (single-asset only)
 */
app.post("/api/edit-asset", async (req, res) => {
  try {
    const { assetPath, instruction, designContext } = req.body || {}
    if (!assetPath || !instruction || !designContext) {
      return res.status(400).json({
        error: "assetPath, instruction, and designContext are required"
      })
    }

    const updatedPath = await editAsset({
      openai,
      assetPath,
      instruction,
      designContext
    })

    res.json({
      success: true,
      assetPath: updatedPath
    })
  } catch (error) {
    console.error("Error editing asset:", error)
    res.status(500).json({
      error: "Failed to edit asset",
      message: error.message
    })
  }
})

/**
 * Layout save endpoint
 * Persists normalized layout metadata
 */
app.post("/api/layout/save", (req, res) => {
  try {
    const { gameName, screenName, elements } = req.body || {}
    if (!gameName || !screenName || !Array.isArray(elements)) {
      return res.status(400).json({
        error: "gameName, screenName, and elements are required"
      })
    }

    const filePath = saveLayoutFile({ gameName, screenName, elements })

    res.json({
      success: true,
      path: filePath
    })
  } catch (error) {
    console.error("Error saving layout:", error)
    res.status(500).json({
      error: "Failed to save layout",
      message: error.message
    })
  }
})

/**
 * Draft summary stream (SSE)
 */
app.get("/api/assets/summary/stream", handleAssetSummaryStream)

/**
 * Regenerate draft asset
 */
app.post("/api/assets/regenerate", async (req, res) => {
  try {
    const { sessionId = "default", screenName, instructions } = req.body || {}
    if (!screenName) {
      return res.status(400).json({ error: "screenName is required" })
    }
    const session = getSession(sessionId)
    const result = await regenerateDraft({
      openai,
      session,
      screenName,
      instructions
    })
    res.json({ draft: result.draft, draftAssets: session.draftAssets || {} })
  } catch (error) {
    console.error("Error regenerating draft:", error)
    res.status(500).json({ error: "Failed to regenerate draft", message: error.message })
  }
})

/**
 * Commit draft asset to final assets folder
 */
app.post("/api/assets/commit", async (req, res) => {
  try {
    const { sessionId = "default", screenName, draftId, assetMeta } = req.body || {}
    if (!screenName || !draftId || !assetMeta) {
      return res.status(400).json({ error: "screenName, draftId, assetMeta are required" })
    }
    const session = getSession(sessionId)
    const { draft, absoluteDraft } = moveDraftToFinal({ session, screenName, draftId })

    const finalDir = buildFinalDir(session.gameName || "game_ui", screenName)
    fs.mkdirSync(finalDir, { recursive: true })
    const finalPath = path.join(finalDir, draft.fileName.replace("_draft", ""))
    fs.copyFileSync(absoluteDraft, finalPath)
    await runComfyTrimSingle(finalPath)

    const finalAsset = {
      ...assetMeta,
      fileName: path.basename(finalPath),
      path: path.relative(process.cwd(), finalPath)
    }
    addFinalAssetToSession({ session, screenName, asset: finalAsset })

    res.json({ asset: finalAsset, assets: session.assets || {} })
  } catch (error) {
    console.error("Error committing draft:", error)
    res.status(500).json({ error: "Failed to commit draft", message: error.message })
  }
})

/**
 * Game build: generate blueprint
 */
app.post("/api/game-build/blueprint", (req, res) => {
  try {
    const { prdText, sessionId = "default" } = req.body || {}
    if (!prdText) {
      return res.status(400).json({ error: "prdText is required" })
    }
    const blueprint = generateGameBlueprint({ sessionId, prdText })
    res.json({ blueprint })
  } catch (error) {
    console.error("Error generating blueprint:", error)
    res.status(500).json({
      error: "Failed to generate blueprint",
      message: error.message
    })
  }
})

/**
 * Game build: start build
 */
app.post("/api/game-build/start", async (req, res) => {
  const { sessionId = "default", blueprint } = req.body || {}
  if (!blueprint) {
    return res.status(400).json({ error: "blueprint is required" })
  }

  updateBuildStatus(sessionId, "queued")
  appendBuildLog(sessionId, "INFO", "Build queued...")

  runGameBuild({ sessionId, blueprint }).catch((error) => {
    console.error("Game build failed:", error)
    appendBuildLog(sessionId, "ERROR", error.message || "Game build failed")
    updateBuildStatus(sessionId, "error")
  })

  res.json({ success: true })
}) 

/**
 * Game build: stream logs (SSE)
 */
app.get("/api/game-build/stream", handleGameBuildStream)

app.listen(3001, () => {
  console.log("Backend running on http://localhost:3001")
  console.log("Architecture: Backend Agent Runtime → OpenAI (text + image)")
})



