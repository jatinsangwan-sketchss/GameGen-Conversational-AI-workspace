export function buildWorkflow(imageEntries) {
  if (!Array.isArray(imageEntries) || imageEntries.length === 0) {
    throw new Error("buildWorkflow: imageEntries must be a non-empty array")
  }

  const prompt = {}
  let nodeId = 1

  imageEntries.forEach((entry) => {
    const inputName = entry?.inputName
    const outputPrefix = entry?.outputPrefix

    if (!inputName || !outputPrefix) {
      throw new Error("buildWorkflow: entry must include inputName and outputPrefix")
    }

    const loadId = String(nodeId++)
    const trimId = String(nodeId++)
    const saveId = String(nodeId++)

    prompt[loadId] = {
      class_type: "LoadImageWithAlpha",
      inputs: {
        image: inputName
      }
    }

    prompt[trimId] = {
      class_type: "TrimTransparentDivisible",
      inputs: {
        image: [loadId, 0],
        alpha_threshold: 0.01,
        margin: 0
      }
    }

    prompt[saveId] = {
      class_type: "SaveImage",
      inputs: {
        images: [trimId, 0],
        filename_prefix: outputPrefix
      }
    }
  })

  return { prompt }
}
