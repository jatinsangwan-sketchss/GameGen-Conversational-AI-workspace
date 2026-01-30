import dotenv from "dotenv"
dotenv.config()

import express from "express"
import cors from "cors"
import { callAgent } from "./v2LLM-service.js"
import { editImageWithMask } from "./llm-service.js"
import { checkSession, getSession, sessions as sessionStore } from "./sessions.js"



const app = express()
app.use(cors())
app.use(express.json({ limit: "25mb" }))

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

    let artifacts = []
    if (checkSession(sessionId)) {
      const session = getSession(sessionId)
      artifacts = Array.isArray(session.artifacts) ? session.artifacts : []
    } else {
      artifacts = getSession(sessionId).artifacts
    }

    // Backend = agent runtime
    const response = await callAgent(message, sessionId)

    /**
     * Expected response format:
     * {
     *   chat: string,
     *   artifacts: [
     *     { type: "ui_spec", screen: string, content: object },
     *     { type: "image", screen: string, content: { url: string } }
     *   ]
     * }
     */
    if (response?.artifacts?.length) {
      const session = getSession(sessionId)
      const stored = Array.isArray(session.artifacts) ? session.artifacts : []

      const withIds = response.artifacts.map((artifact) => {
        if (artifact.id) return artifact

        const match = stored.find((a) => {
          if (a.type !== artifact.type) return false
          if (artifact.screen && a.screen === artifact.screen) return true
          return false
        })

        return {
          ...artifact,
          id: match?.id || `${artifact.type}_${artifact.screen || "image"}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        }
      })

      withIds.forEach((newArtifact) => {
        const existingIndex = stored.findIndex(
          (a) => a.id === newArtifact.id || (a.type === newArtifact.type && a.screen === newArtifact.screen)
        )
        if (existingIndex >= 0) {
          stored[existingIndex] = newArtifact
        } else {
          stored.push(newArtifact)
        }
      })

      session.artifacts = stored
    }

    const session = getSession(sessionId)
    const allArtifacts = Array.isArray(session.artifacts) ? session.artifacts : []
    const payload = { ...response, artifacts: allArtifacts }
    console.log(payload)
    res.json(payload)
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
  sessionStore.delete(sessionId) // Also clear from session store
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

app.listen(3001, () => {
  console.log("Backend running on http://localhost:3001")
  console.log("Architecture: Backend Agent Runtime → OpenAI (text + image)")
})
