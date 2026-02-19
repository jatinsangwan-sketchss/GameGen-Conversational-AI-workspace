import path from "path"

export const COMFY_BASE_URL =
  process.env.COMFY_BASE_URL || "http://127.0.0.1:8188"

export const COMFY_OUTPUT_DIR =
  process.env.COMFY_OUTPUT_DIR ||
  path.join(process.cwd(), "ComfyUI", "output")

export const POLL_INTERVAL = 1000
export const MAX_WAIT_TIME = 120000