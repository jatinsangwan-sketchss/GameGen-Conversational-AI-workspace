export function createSession() {
  return {
    designContext: null,
    designTokens: null,
    originalPRD: null,
    screensMetadata: [],
    assets: {},
    draftAssets: {},
    gameName: null,
    lastExtractionAt: null,
    lastAssetGenerationAt: null
  }
}
