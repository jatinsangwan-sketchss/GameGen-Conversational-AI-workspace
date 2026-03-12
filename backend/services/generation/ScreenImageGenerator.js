import { IMAGE_MODEL } from "../../config/openai.config.js"
import { saveScreenMockup } from "../storage/FileStorageService.js"

export async function generateImageForScreen({ openai, screen, designContext }) {
  const prompt = `
Design System:
${designContext}

Screen Name:
${screen.name}

Screen Purpose:
${screen.description}

Create a high-quality mobile UI mockup.
`

  const result = await openai.images.generate({
    model: IMAGE_MODEL,
    prompt,
    size: "1024x1536"
  })

  const image = result.data?.[0]
  if (!image) throw new Error("No image returned")

  if (image.url) return image.url
  if (image.b64_json) return `data:image/png;base64,${image.b64_json}`

  throw new Error("Invalid image response")
}

export async function generateScreenImages({ openai, screens, designContext, gameName }) {
  const results = []
  for (const screen of screens || []) {
    const image = await generateImageForScreen({ openai, screen, designContext })
    const savedPath = await saveScreenMockup(
      image,
      gameName || "game_ui",
      screen.name
    )
    results.push({
      ...screen,
      image: savedPath || image
    })
  }
  return results
}
