import OpenAI from "openai"
import dotenv from "dotenv"
import { getSession } from "./sessions.js"

dotenv.config()

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const TEXT_MODEL = "gpt-4o"
const IMAGE_MODEL = "gpt-image-1.5"

/**
 * Step 1: PRD → screen-level descriptions
 */
async function extractScreensFromPRD(prdText) {
  const systemPrompt = `
You are a product designer assistant.

Your task:
- Read the PRD
- Identify the core UI screens
- For each screen, write a short description suitable for image generation

Rules:
- Return ONLY valid JSON
- No markdown
- No explanations

Output format:
{
  "screens": [
    {
      "id": "string",
      "name": "string",
      "description": "string"
    }
  ]
}
`

  const response = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prdText }
    ],
    response_format: { type: "json_object" }
  })

  return JSON.parse(response.choices[0].message.content)
}

/**
 * Step 2: screen description → image
 */
async function generateImageForScreen(screen, globalContext) {
  const prompt = `
Create a clean, modern mobile app UI screen.

App context:
${globalContext}

Screen name:
${screen.name}

Screen purpose:
${screen.description}

Style:
- Mobile UI
- Minimal
- Professional
- High-quality design mockup
`

  const result = await openai.images.generate({
    model: IMAGE_MODEL,
    prompt,
    size: "1024x1536"
  })

  const image = result.data?.[0]
  if (!image) throw new Error("No image returned")

  if (image.url) return image.url
  if (image.b64_json) {
    return `data:image/png;base64,${image.b64_json}`
  }

  throw new Error("Invalid image response")
}

/**
 * MAIN ENTRY — PRD → multiple screens
 */
export async function callAgent(message, sessionId) {
  const session = getSession(sessionId)

  // 1. Extract screens from PRD
  const { screens } = await extractScreensFromPRD(message)

  const artifacts = []

  // 2. Generate image per screen
  for (const screen of screens) {
    const imageUrl = await generateImageForScreen(screen, message)

    artifacts.push({
      type: "image",
      screen: screen.name,
      content: { url: imageUrl }
    })
  }

  return {
    chat: `I identified ${screens.length} core screens and generated them based on your PRD.`,
    artifacts
  }
}

/**
 * Image editing with mask (unchanged)
 */
export async function editImageWithMask(
  imageSource,
  maskDataURL,
  prompt
) {
  const editPrompt = `
Modify ONLY the masked area.
${prompt}
Preserve the rest of the image exactly.
`

  const result = await openai.images.edits({
    model: IMAGE_MODEL,
    image: imageSource,
    mask: maskDataURL,
    prompt: editPrompt,
    size: "1024x1536"
  })

  const image = result.data?.[0]
  if (!image) throw new Error("No edited image returned")

  if (image.url) return image.url
  if (image.b64_json) {
    return `data:image/png;base64,${image.b64_json}`
  }

  throw new Error("Invalid edited image response")
}
