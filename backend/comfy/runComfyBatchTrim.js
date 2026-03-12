import fs from "fs"
import path from "path"
import {
    COMFY_BASE_URL,
    COMFY_OUTPUT_DIR,
    comfyConfig,
    POLL_INTERVAL,
    MAX_WAIT_TIME,
} from "./comfyConfig.js"
import { buildWorkflow } from "./buildWorkflow.js"

function normalizeName(input) {
    return String(input)
        .replace(/\.png$/i, "")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
}

function copyToComfyInput(imageEntries) {
    const inputDir = comfyConfig.inputDir


    // Clear existing input files
    fs.readdirSync(inputDir).forEach(entry => {
        const entryPath = path.join(inputDir, entry)
        try {
            const stats = fs.statSync(entryPath)
            if (stats.isFile()) {
                fs.unlinkSync(entryPath)
            }
        } catch (err) {
            console.warn(`[comfy] Failed to clean input entry: ${entryPath}`, err)
        }
    })
    imageEntries.forEach((entry) => {
        const destPath = path.join(inputDir, entry.inputName)
        fs.copyFileSync(entry.originalPath, destPath)
    })
}

function collectAssetPaths(session) {
    const assetsByScreen = session?.assets || {}
    const items = []

    Object.values(assetsByScreen).forEach((screenAssets) => {
        if (!Array.isArray(screenAssets)) return
        screenAssets.forEach((asset) => {
            if (!asset?.path) return
            const absolutePath = path.isAbsolute(asset.path)
                ? asset.path
                : path.join(process.cwd(), asset.path)
            items.push({
                originalPath: absolutePath,
                fileName: asset.fileName,
                assetPath: asset.path
            })
        })
    })

    return items
}

async function queueComfyWorkflow(imagePaths) {
    const body = buildWorkflow(imagePaths)

    const res = await fetch(`${COMFY_BASE_URL}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
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

async function waitForComfyCompletion(promptId) {
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

function replaceTrimmedAssets(fileMap) {
    if (!fs.existsSync(COMFY_OUTPUT_DIR)) {
        throw new Error(`Comfy output directory not found: ${COMFY_OUTPUT_DIR}`)
    }

    const outputFiles = fs.readdirSync(COMFY_OUTPUT_DIR)
    const outputMap = new Map()

    outputFiles.forEach((file) => {
        const match = file.match(/^(.*)_\d+_?\.png$/i)
        if (!match) return
        const baseName = `${match[1]}`
        const fullPath = path.join(COMFY_OUTPUT_DIR, file)
        const stats = fs.statSync(fullPath)
        const current = outputMap.get(baseName)
        if (!current || stats.mtimeMs > current.mtimeMs) {
            outputMap.set(baseName, { path: fullPath, mtimeMs: stats.mtimeMs })
        }
    })

    let replaced = 0
    let missing = 0
    const availableOutputs = Array.from(outputMap.keys())

    fileMap.forEach((mapEntry) => {
        const output = outputMap.get(mapEntry.outputPrefix)
        if (!output) {
            missing += 1
            return
        }
        fs.copyFileSync(output.path, mapEntry.originalPath)
        fs.unlinkSync(output.path)
        replaced += 1
    })
    if (missing > 0) {
        console.warn("[comfy] Missing output files for assets.")
        console.warn("[comfy] Output files available:", availableOutputs.slice(0, 10))
    }

    return { replaced, missing }
}

export async function runComfyBatchTrim(session) {
    const items = collectAssetPaths(session)

    if (!items.length) {
        console.log("[comfy] No assets to trim")
        return
    }

    const existingItems = items.filter((item) => fs.existsSync(item.originalPath))
    if (!existingItems.length) {
        console.log("[comfy] No asset files found on disk")
        return
    }

    const entries = existingItems.map((item, index) => {
        const base = normalizeName(item.fileName || path.basename(item.originalPath))
        const outputPrefix = `${index}_${base}`
        return {
            inputName: `${outputPrefix}.png`,
            outputPrefix,
            originalPath: item.originalPath
        }
    })
    console.log(`[comfy] Preparing ${entries.length} assets`)

    // STEP 1 — Copy to Comfy input folder
    copyToComfyInput(entries)

    // STEP 2 — Queue workflow
    const promptId = await queueComfyWorkflow(entries)
    console.log(`[comfy] Prompt queued: ${promptId}`)

    // STEP 3 — Wait until finished
    await waitForComfyCompletion(promptId)

    console.log("[comfy] Workflow completed")

    // STEP 4 — Replace originals
    const { replaced, missing } = replaceTrimmedAssets(entries)
    console.log(`[comfy] Replaced ${replaced} assets, missing ${missing}`)
    // fs.readdirSync(COMFY_OUTPUT_DIR).forEach(file => {
    //     fs.unlinkSync(path.join(COMFY_OUTPUT_DIR, file))
    // })

    console.log("[comfy] Production trim complete")
}



export { queueComfyWorkflow, waitForComfyCompletion, replaceTrimmedAssets }