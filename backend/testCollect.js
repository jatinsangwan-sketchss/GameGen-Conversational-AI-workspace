// import path from "path"
// import { collectPngPaths } from "./comfy/collectPngPaths.js"

// const assetsRoot = path.join(process.cwd(), "assets")

// const pngFiles = collectPngPaths(assetsRoot)

// console.log("Total PNG files found:", pngFiles.length)
// console.log(pngFiles)

import path from "path"
import { runComfyBatchTrimFromFolder } from "./comfy/runComfyBatchTrim.js"

async function test() {
  const assetsRoot = path.join(process.cwd(), "assets")

  console.log("Starting Comfy batch trim...")

  await runComfyBatchTrimFromFolder(assetsRoot)

  console.log("Finished Comfy batch trim.")
}

test().catch(console.error)
