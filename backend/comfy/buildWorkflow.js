export function buildWorkflow(imagePaths) {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    throw new Error("buildWorkflow: imagePaths must be a non-empty array")
  }

  const prompt = {}
  let nodeId = 1

  imagePaths.forEach((imagePath) => {
    const loadId = String(nodeId++)
    const trimId = String(nodeId++)
    const saveId = String(nodeId++)

    prompt[loadId] = {
      class_type: "LoadImageWithAlpha",
      inputs: {
        image: imagePath
      }
    }

    prompt[trimId] = {
      class_type: "TrimTransparentDivisible",
      inputs: {
        image: [loadId, 0]
      }
    }

    prompt[saveId] = {
      class_type: "SaveImage",
      inputs: {
        images: [trimId, 0]
      }
    }
  })

  return { prompt }
}