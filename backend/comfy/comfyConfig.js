import path from "path"

/**
 * PRODUCTION CONFIG
 * Override via environment variables if needed
 */
export const COMFY_BASE_URL =
  process.env.COMFY_BASE_URL || "http://127.0.0.1:8000"

export const COMFY_INPUT_DIR =
  process.env.COMFY_INPUT_DIR ||
  "/Users/jatin.sangwan/Documents/ComfyUI/input"

export const COMFY_OUTPUT_DIR =
  process.env.COMFY_OUTPUT_DIR ||
  "/Users/jatin.sangwan/Documents/ComfyUI/output"

export const POLL_INTERVAL = 10000
export const MAX_WAIT_TIME = 120000

/**
 * Local dev convenience wrapper (optional)
 */
export const comfyConfig = {
  server: COMFY_BASE_URL,
  inputDir: COMFY_INPUT_DIR,
  outputDir: COMFY_OUTPUT_DIR
}
