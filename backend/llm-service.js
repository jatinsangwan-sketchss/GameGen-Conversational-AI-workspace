import OpenAI from "openai"
import dotenv from "dotenv"
dotenv.config()
import { getSession } from "./sessions.js"
import { File } from "node:buffer"

// Initialize OpenAI client only if API key is available
let openai = null
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  })
} else {
  console.warn("⚠️  OPENAI_API_KEY not set. Set it in .env file to enable AI features.")
}

// const TEXT_MODEL = "gpt-4o" // Using gpt-4o instead of gpt-5.1 (which doesn't exist)
// const IMAGE_MODEL = "gpt-image-1.5"
const IMAGE_MODEL = "gpt-image-1.5"

/**
 * SYSTEM PROMPT
 * Defines the agent behavior (this replaces Warp agent definition)
 */
const SYSTEM_PROMPT = `
You are an AI UI designer agent.

Your responsibilities:
- Convert UI PRDs into structured UI specifications (ui_spec)
- If ui_specs already exist, apply user edits to them
- Treat ui_spec as the source of truth
- Never modify images directly
- Always update ui_spec first

Rules:
- Output ONLY valid JSON
- Do not include markdown
- Do not include explanations
- Be precise and deterministic

Output format:
{
  "chat": string,
  "ui_specs": {
    "<screen_id>": {
      "screen": string,
      "components": array
    }
  }
}
`

/**
 * Build the runtime prompt
 * Injects session memory + user message
 */
function buildPrompt(uiSpecs, userMessage) {
  let memoryBlock = ""

  if (Object.keys(uiSpecs).length > 0) {
    memoryBlock = `
Existing UI Specs:
${JSON.stringify(uiSpecs, null, 2)}
`
  }

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${memoryBlock}\nUser request:\n${userMessage}` }
  ]
}

/**
 * Generate or edit UI specs using text model
 */
async function generateUiSpecs(uiSpecs, userMessage) {
  if (!openai) {
    throw new Error("OpenAI client not initialized. Set OPENAI_API_KEY in .env")
  }

  const completion = await openai.chat.completions.create({
    model: TEXT_MODEL,
    messages: buildPrompt(uiSpecs, userMessage),
    temperature: 0.2,
    response_format: { type: "json_object" }
  })

  const raw = completion.choices[0].message.content

  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error("Failed to parse UI spec JSON from model")
  }
}

/**
 * Convert a UI spec into an image prompt
 */
function buildImagePrompt(uiSpec) {
  const components = uiSpec.components
    .map(c => `- ${c.type}${c.label ? ` (${c.label})` : ""}`)
    .join("\n")

  return `
Mobile app UI screen.
Portrait 9:16.
Screen name: ${uiSpec.screen}

Components:
${components}

Style:
- Modern UI
- Clean layout
- High quality
- App design mockup
`
}

/**
 * Generate image from UI spec or direct prompt
 */
async function generateImage(uiSpecOrPrompt, message) {
  if (!openai) {
    throw new Error("OpenAI client not initialized. Set OPENAI_API_KEY in .env")
  }

  // If it's a UI spec object, convert to prompt; otherwise use as-is
  // const prompt = typeof uiSpecOrPrompt === 'string' 
  //   ? uiSpecOrPrompt 
  //   : buildImagePrompt(uiSpecOrPrompt)

  const prompt = `
    Create a clean modern mobile UI splash screen.
    Style: minimal, flat design.
    ${message}

  `
  const result = await openai.images.generate({
    model: IMAGE_MODEL,
    // prompt: prompt,
    prompt: prompt,
    n: 1,
    size: "1024x1536",
    // Explicitly request a URL so the frontend <img> src is valid
    // response_format: "url"
  })

  // Depending on the SDK/version, images may return either .url or .b64_json.
  // We prefer .url, but fall back to building a data URL from base64 if needed.
  const imageData = result.data?.[0]
  if (!imageData) {
    throw new Error("Image generation returned no data")
  }

  if (imageData.url) {
    return imageData.url
  }

  if (imageData.b64_json) {
    console.log("here is the b64_json", imageData.b64_json)
    return `data:image/png;base64,${imageData.b64_json}`
  }

  throw new Error("Image generation did not return a URL or base64 image data")
}

/**
 * Edit image with mask using OpenAI's image editing API
 * @param {string} imageSource - URL or base64 data URL of the original image
 * @param {string} maskDataURL - Base64 data URL of the mask (white = edit area, black = keep)
 * @param {string} prompt - Description of what to generate in the masked area
 */
export async function editImageWithMask(imageSource, maskDataURL, prompt, artifactId) {
  if (!openai) {
    throw new Error("OpenAI client not initialized. Set OPENAI_API_KEY in .env")
  }

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

  const editPrompt = `Modify ONLY the selected region : ${prompt}`
  const result = await openai.images.edit({
    model: IMAGE_MODEL,
    image: imageFile,
    mask: maskFile,
    prompt: editPrompt,
    n: 1,
    size: "1024x1536"
  })

  const imageData = result.data?.[0]
  if (!imageData) {
    throw new Error("Image editing returned no data")
  }

  if (imageData.url) {
    return imageData.url
  }

  if (imageData.b64_json) {
    return `data:image/png;base64,${imageData.b64_json}`
  }

  throw new Error("Image editing did not return a URL or base64 image data")
}

/**
 * MAIN AGENT FUNCTION FOR UI GEN
 * This is the "agent loop"
 */
export async function callAgent(message, sessionId = "default", artifacts) {
  if (!openai) {
    return {
      chat: "OpenAI API key not configured.",
      artifacts: []
    }
  }


  try {
    const imageUrl = await generateImage(null, message)

    artifacts.push({
      type: "image",
      content: { url: imageUrl }
    })

    return {
      chat: "Here’s the image based on your prompt.",
      artifacts
    }
  } catch (err) {
    console.error(err)
    return {
      chat: "Something went wrong while generating the image.",
      artifacts: []
    }
  }
}
