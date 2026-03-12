import { ASSET_BASE_URL } from '../config/api.config'

export function buildAssetUrl(path) {
  if (!path) return ''
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  let cleaned = path.replace(/^\//, '')
  if (cleaned.startsWith('assets/')) {
    cleaned = cleaned.replace(/^assets\//, '')
  }
  return `${ASSET_BASE_URL}/${cleaned}`
}
