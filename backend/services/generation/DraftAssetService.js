import path from "path"
import fs from "fs"
import { generateDraftAsset } from "./DraftAssetGenerator.js"
import { buildDraftAssetPrompt } from "./buildDraftAssetPrompt.js"
import { normalizeComponentRequest } from "./ComponentNormalizer.js"
import { streamAssetSummary } from "../summary/AssetSummaryService.js"

function getScreenAssets(session, screenName) {
  return session?.assets?.[screenName] || []
}

function findScreen(session, screenName) {
  const screens = session?.screensMetadata || []
  return screens.find((screen) => screen.name === screenName)
}

function ensureDraftStore(session, screenName) {
  if (!session.draftAssets) session.draftAssets = {}
  if (!session.draftAssets[screenName]) session.draftAssets[screenName] = []
}

export async function createDraftFromMessage({  // we are already recieving the openai instance no need to instantiate it again
  openai,
  session,
  userMessage
}) {
  console.log("[createDraftFromMessage] message:", userMessage)
  const screens = session?.screensMetadata || []
  const componentSpec = await normalizeComponentRequest({ openai, userMessage, screens })  // done
  const componentSpecNoText = {
    ...componentSpec,
    label: null
  }
  const screenName = componentSpecNoText.screenName
  const screen = findScreen(session, screenName)

  console.log("[createDraftFromMessage] screen:", screenName)

  const basePrompt = buildDraftAssetPrompt({    // done
    designContext: session.designContext,
    designTokens: session.designTokens,
    existingScreenAssets: getScreenAssets(session, screenName),
    componentSpec: componentSpecNoText,
    screenName
  })

//   Component Spec: From buildDraftAssetPrompt
// - type: ${componentSpec.type}   btn/icon/background
// - name: ${componentSpec.name}   name of the component
// - label: ${componentSpec.label || "none"}    name on the asset  ---- not needed
// - variant: ${componentSpec.variant || "default"}
// - size: ${componentSpec.size || "medium"}   size of the component

  console.log("[createDraftFromMessage] prompt ready", {
    screenName,
    hasDesignContext: Boolean(session.designContext),
    hasDesignTokens: Boolean(session.designTokens)
  })

  const summaryPromise = streamAssetSummary({
    openai,
    sessionId: session.sessionId || "default",
    componentSpec: componentSpecNoText,
    screenName,
    designContext: session.designContext,
    designTokens: session.designTokens
  }).catch((err) => {
    console.warn("[summary] failed to stream summary", err)
  })

  const drafts = []
  if (componentSpecNoText.type === "button") {
    if (componentSpec.iconOnly) {
      console.log("[createDraftFromMessage] icon-only request")
      const iconSpec = {
        ...componentSpecNoText,
        type: "icon",
        composition_rule: "icon_only",
        label: null
      }
      const iconPrompt = basePrompt + `\nComposition Rule:\nicon_only`
      const iconDraft = await generateDraftAsset({
        openai,
        prompt: iconPrompt,
        componentSpec: iconSpec,
        gameName: session.gameName || "game_ui",
        screenName
      })
      drafts.push({ draft: iconDraft, componentSpec: iconSpec, prompt: iconPrompt })
    } else {
      console.log("[createDraftFromMessage] generating button container")
      const containerSpec = {
        ...componentSpecNoText,
        composition_rule: "container_only"
      }
      const containerPrompt = basePrompt + `\nComposition Rule:\ncontainer_only`
      const containerDraft = await generateDraftAsset({
        openai,
        prompt: containerPrompt,
        componentSpec: containerSpec,
        gameName: session.gameName || "game_ui",
        screenName
      })
      drafts.push({ draft: containerDraft, componentSpec: containerSpec, prompt: containerPrompt })

      if (componentSpecNoText.splitToIcon) {
        console.log("[createDraftFromMessage] generating icon companion")
        const iconSpec = {
          ...componentSpecNoText,
          name: `icon_${componentSpecNoText.name}`,
          type: "icon",
          composition_rule: "icon_only",
          label: null
        }
        const iconPrompt = basePrompt + `\nComposition Rule:\nicon_only`
        const iconDraft = await generateDraftAsset({
          openai,
          prompt: iconPrompt,
          componentSpec: iconSpec,
          gameName: session.gameName || "game_ui",
          screenName
        })
        drafts.push({ draft: iconDraft, componentSpec: iconSpec, prompt: iconPrompt })
      }
    }
  } else {  
    console.log("[createDraftFromMessage] generating single asset")
    const draftAsset = await generateDraftAsset({
      openai,
      prompt: basePrompt,
      componentSpec,
      gameName: session.gameName || "game_ui",
      screenName
    })
    drafts.push({ draft: draftAsset, componentSpec, prompt: basePrompt })
  }

  ensureDraftStore(session, screenName)
  drafts.forEach(({ draft, componentSpec: spec, prompt }) => {
    session.draftAssets[screenName].push({
      ...draft,
      componentSpec: spec,
      prompt
    })
  })
  console.log("[createDraftFromMessage] drafts stored", {
    screenName,
    count: drafts.length
  })

  await summaryPromise

  return {
    drafts: drafts.map((item) => item.draft),
    screen,
    componentSpec: componentSpecNoText
  }
}

export async function regenerateDraft({
  openai,
  session,
  screenName,
  instructions
}) {
  console.log("[regenerateDraft] start", { screenName })
  const drafts = session?.draftAssets?.[screenName] || []
  const existing = drafts[drafts.length - 1]
  if (!existing) {
    throw new Error("No draft asset found to regenerate")
  }

  const componentSpec = existing.componentSpec
  const prompt = buildDraftAssetPrompt({
    designContext: session.designContext,
    designTokens: session.designTokens,
    existingScreenAssets: getScreenAssets(session, screenName),
    componentSpec,
    screenName
  }) + `\nUser adjustments:\n${instructions || "none"}`

  const draftAsset = await generateDraftAsset({
    openai,
    prompt,
    componentSpec,
    gameName: session.gameName || "game_ui",
    screenName
  })

  drafts.push({
    ...draftAsset,
    componentSpec,
    prompt
  })
  console.log("[regenerateDraft] draft replaced", { screenName, draftId: draftAsset.id })

  return { draft: draftAsset }
}

export function moveDraftToFinal({
  session,
  screenName,
  draftId
}) {
  console.log("[moveDraftToFinal] start", { screenName, draftId })
  const drafts = session?.draftAssets?.[screenName] || []
  const draft = drafts.find((item) => item.id === draftId)
  if (!draft) throw new Error("Draft asset not found")

  const absoluteDraft = path.isAbsolute(draft.path)
    ? draft.path
    : path.join(process.cwd(), draft.path)

  if (!fs.existsSync(absoluteDraft)) {
    throw new Error("Draft file missing on disk")
  }

  return {
    draft,
    absoluteDraft
  }
}

export function addFinalAssetToSession({ session, screenName, asset }) {
  if (!session.assets) session.assets = {}
  if (!session.assets[screenName]) session.assets[screenName] = []
  const exists = session.assets[screenName].some(
    (item) => item?.path === asset?.path || item?.fileName === asset?.fileName
  )
  if (exists) {
    console.log("[addFinalAssetToSession] duplicate ignored", {
      screenName,
      fileName: asset?.fileName,
      path: asset?.path
    })
    return
  }
  session.assets[screenName].push(asset)
}
