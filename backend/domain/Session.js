export function createSession() {
  return {
    designContext: null,
    originalPRD: null,
    screensMetadata: [],
    assets: {},
    gameName: null,
    lastExtractionAt: null,
    lastAssetGenerationAt: null
  }
}
