import OpenAI from "openai"
import dotenv from "dotenv"
import { File } from "node:buffer"
import { getSession } from "./sessions.js"
import { runBatchTrim } from "./services/comfy/ComfyOrchestrator.js"
import { generateAssetsForSession } from "./services/generation/AssetGenerator.js"
import { generateScreenImages } from "./services/generation/ScreenImageGenerator.js"
import { stripLayoutFromScreens } from "./services/generation/LayoutGenerator.js"
import { classifyIntent as classifyIntentService } from "./services/extraction/IntentClassifier.js"
import { extractDesignContext as extractDesignContextService } from "./services/extraction/DesignContextExtractor.js"
import { extractScreensFromPRD as extractScreensFromPRDService } from "./services/extraction/ScreenExtractor.js"
import { extractGameNameFromPRD as extractGameNameFromPRDService } from "./services/extraction/GameNameExtractor.js"


dotenv.config()

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

// Extraction logic moved to services/extraction/*
/* -------------------------------------------
   DESIGN CONTEXT EXTRACTION
-------------------------------------------- */

// Extraction logic moved to services/extraction/*

/* -------------------------------------------
   SCREEN EXTRACTION
-------------------------------------------- */

// async function extractScreensFromPRD(prdText) {
//  const systemPrompt = `
//You are a production-level mobile game UI planner.

//Your job:
//From the PRD, extract structured UI screens and components.

//For each screen return:

//1. name
//2. description
//3. components (structured list)

//-------------------------------------
//COMPONENT STRUCTURE
//-------------------------------------

//Each component must include:

//- type (button, icon, panel, background, indicator, grid, text, etc.)
//- name (snake_case, unique per screen)
//- label (string or null)
//- variant (primary, secondary, circular, glass, etc.)

//Return ONLY valid JSON.

//Output format:

//{
//  "screens": [
//    {
//      "name": "string",
//      "description": "string",
//      "components": [
//        {
//          "type": "string",
//          "name": "string_snake_case",
//          "label": "string_or_null",
//          "variant": "string_or_null"
//        }
//      ]
//    }
//  ]
//}
//`

//
//  const response = await openai.chat.completions.create({
//    model: TEXT_MODEL,
//    temperature: 0.2,
//    messages: [
//      { role: "system", content: systemPrompt },
//      { role: "user", content: prdText }
//    ],
//    response_format: { type: "json_object" }
//  })
//
//  return JSON.parse(response.choices[0].message.content)
//}



// async function extractGameNameFromPRD(prdText) {
//  const systemPrompt = `
//Extract the game name from the PRD.
//Return only the name in lowercase snake_case.
//If none found, return "game_ui".
//  `
//
//  const response = await openai.chat.completions.create({
//    model: TEXT_MODEL,
//    temperature: 0,
//    messages: [
//      { role: "system", content: systemPrompt },
//      { role: "user", content: prdText }
//    ]
//  })
//
//  return response.choices[0].message.content.trim().replace(/\s+/g, "_")
// }

/* -------------------------------------------
   IMAGE GENERATION (STATEFUL)
-------------------------------------------- */

/* -------------------------------------------
   MAIN ENTRY
-------------------------------------------- */

export async function callAgent(message, sessionId) {
  const session = getSession(sessionId)
  const safeMessage = typeof message === "string" ? message : ""
  const { intent } = await classifyIntentService({
    openai,
    message: safeMessage,
    session
  })

  console.log("intent::::", intent)

  /* -------- SMALL TALK -------- */
  if (intent === "SMALL_TALK") {
    return {
      chat: "Hi! Provide a PRD or modify the existing design."
    }
  }

  /* -------- NEW PRD -------- */
  if (intent === "NEW_PRD") {
    const designContext = await extractDesignContextService({ openai, prdText: safeMessage })
    const { screens } = await extractScreensFromPRDService({ openai, prdText: safeMessage })
    const gameName = await extractGameNameFromPRDService({ openai, prdText: safeMessage })
    const screensWithImages = await generateScreenImages({
      openai,
      screens,
      designContext,
      gameName
    })

    session.designContext = designContext
    session.originalPRD = safeMessage
    session.screensMetadata = screensWithImages
    session.gameName = gameName

    console.log("this is the design context::::", designContext)
    console.log("extractScreensFromPRD:::::", screensWithImages)
    console.log("GameName:::::", gameName)

    // Asset-first generationx
    const { assets, screens: screensWithImagesAndAssets } =
      await generateAssetsForSession({ openai, session, runComfyBatchTrim: runBatchTrim })

    return {
      chat: `Generated ${screens.length} screen mockups and structured UI assets.`,
      screens: screensWithImagesAndAssets,
      assets
    }
  }

  /* -------- UPDATE DESIGN -------- */
  if (intent === "UPDATE_DESIGN" && session.designContext) {
    const updatedContext = await extractDesignContextService({
      openai,
      prdText: session.designContext + "\nUser update:\n" + safeMessage
    })

    session.designContext = updatedContext

    const screensWithImages = await generateScreenImages({
      openai,
      screens: stripLayoutFromScreens(session.screensMetadata),
      designContext: updatedContext,
      gameName: session.gameName || "game_ui"
    })
    session.screensMetadata = screensWithImages

    const { assets, screens: screensWithImagesAndAssets } =
      await generateAssetsForSession({ openai, session, runComfyBatchTrim: runBatchTrim })

    return {
      chat: "Design system updated. Regenerating screens and assets...",
      screens: screensWithImagesAndAssets,
      assets
    }
  }

  /* -------- REGENERATE ALL -------- */
  if (intent === "REGENERATE_ALL" && session.designContext) {
    const screensWithImages = await generateScreenImages({
      openai,
      screens: stripLayoutFromScreens(session.screensMetadata),
      designContext: session.designContext,
      gameName: session.gameName || "game_ui"
    })
    session.screensMetadata = screensWithImages

    const { assets, screens: screensWithImagesAndAssets } =
      await generateAssetsForSession({ openai, session, runComfyBatchTrim: runBatchTrim })

    return {
      chat: "Regenerated screens and assets using updated design system.",
      screens: screensWithImagesAndAssets,
      assets
    }
  }

  /* -------- FALLBACK -------- */
  return {
    chat: "I couldn't determine your request. Try providing a PRD or updating the design."
  }
}


/* -------------------------------------------
   IMAGE EDITING WITH MASK
-------------------------------------------- */

export async function editImageWithMask(imageSource, maskDataURL, prompt) {
  const editPrompt = `
Modify ONLY the masked area.
${prompt || "Edit the masked area to improve the design"}
Preserve the rest of the image exactly.
`

  const maskBase64 = maskDataURL.includes(",") ? maskDataURL.split(",")[1] : maskDataURL
  const maskBuffer = Buffer.from(maskBase64, "base64")
  const maskFile = new File([maskBuffer], "mask.png", { type: "image/png" })

  let imageBuffer
  let imageType = "image/png"
  let imageName = "image.png"

  if (imageSource.startsWith("data:")) {
    const match = imageSource.match(/^data:(.*?);base64,/)
    if (match?.[1]) {
      imageType = match[1]
    }
    const imageBase64 = imageSource.split(",")[1]
    imageBuffer = Buffer.from(imageBase64, "base64")
  } else {
    const imageRes = await fetch(imageSource)
    if (!imageRes.ok) {
      throw new Error(`Failed to fetch image: ${imageRes.status}`)
    }
    const contentType = imageRes.headers.get("content-type")
    if (contentType) {
      imageType = contentType.split(";")[0].trim()
    }
    const arrayBuffer = await imageRes.arrayBuffer()
    imageBuffer = Buffer.from(arrayBuffer)
  }

  if (imageType === "image/jpg") {
    imageType = "image/jpeg"
  }
  if (imageType === "image/webp") {
    imageName = "image.webp"
  } else if (imageType === "image/jpeg") {
    imageName = "image.jpg"
  }

  const imageFile = new File([imageBuffer], imageName, { type: imageType })

  const result = await openai.images.edit({
    model: IMAGE_MODEL,
    image: imageFile,
    mask: maskFile,
    prompt: editPrompt,
    n: 1,
    size: "1024x1536"
  })

  const image = result.data?.[0]
  if (!image) throw new Error("No edited image returned")

  if (image.url) return image.url
  if (image.b64_json) return `data:image/png;base64,${image.b64_json}`

  throw new Error("Invalid edited image response")
}
