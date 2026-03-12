import dotenv from "dotenv"
dotenv.config()

import express from "express"
import cors from "cors"
import path from "path"
import { callAgent, editImageWithMask } from "./v3LLL-service.js"
import {
  checkSession,
  deleteSession,
  getSession,
  sessions as sessionStore
} from "./sessions.js"
import { saveLayoutFile } from "./utils/layoutStorage.js"



const app = express()
app.use(cors())
app.use(express.json({ limit: "25mb" }))
app.use("/assets", express.static(path.join(process.cwd(), "assets")))

console.log("OPENAI_API_KEY loaded:", !!process.env.OPENAI_API_KEY)

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
      assets: session.assets || {}
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
 * Image editing endpoint with mask
 * Accepts image source (URL or data URL), mask, and prompt
 */
app.post("/api/image/edit", async (req, res) => {
  try {
    const { imageSource, maskDataURL, prompt, artifactId, sessionId = "default" } = req.body

    if (!imageSource || !maskDataURL) {
      return res.status(400).json({
        error: "imageSource and maskDataURL are required"
      })
    }

    const imageUrl = await editImageWithMask(
      imageSource,
      maskDataURL,
      prompt || "Edit the masked area to improve the design"
    )

    const session = getSession(sessionId)
    const stored = Array.isArray(session.artifacts) ? session.artifacts : []
    let updatedArtifact = null

    if (artifactId) {
      const idx = stored.findIndex((a) => a.id === artifactId)
      if (idx >= 0) {
        stored[idx] = {
          ...stored[idx],
          content: { url: imageUrl }
        }
        updatedArtifact = stored[idx]
      }
    }

    if (!updatedArtifact) {
      updatedArtifact = {
        id: artifactId || `image_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: "image",
        content: { url: imageUrl }
      }
      stored.push(updatedArtifact)
    }

    session.artifacts = stored

    res.json({
      success: true,
      artifact: updatedArtifact,
      artifacts: stored
    })
  } catch (error) {
    console.error("Error editing image:", error)
    res.status(500).json({
      error: "Failed to edit image",
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

app.listen(3001, () => {
  console.log("Backend running on http://localhost:3001")
  console.log("Architecture: Backend Agent Runtime → OpenAI (text + image)")
})



