import {
  COMFY_BASE_URL,
  POLL_INTERVAL,
  MAX_WAIT_TIME
} from "../../comfy/comfyConfig.js"

export async function queueWorkflow({ workflow }) {
  const res = await fetch(`${COMFY_BASE_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workflow)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Comfy /prompt failed: ${res.status} ${text}`)
  }

  const data = await res.json()
  if (!data?.prompt_id) {
    throw new Error("Comfy did not return prompt_id")
  }

  return data.prompt_id
}

export async function waitForCompletion({ promptId }) {
  const start = Date.now()

  while (Date.now() - start < MAX_WAIT_TIME) {
    const res = await fetch(`${COMFY_BASE_URL}/history/${promptId}`)
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Comfy /history failed: ${res.status} ${text}`)
    }

    const data = await res.json()
    const entry = data?.[promptId]

    if (entry?.status?.completed === true) {
      return true
    }

    if (entry?.outputs && Object.keys(entry.outputs).length > 0) {
      return true
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
  }

  throw new Error("Comfy workflow timed out")
}
