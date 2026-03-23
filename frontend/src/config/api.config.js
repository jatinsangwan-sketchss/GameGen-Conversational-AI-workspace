export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001'

export const ASSET_BASE_URL =
  import.meta.env.VITE_ASSET_BASE_URL || `${API_BASE_URL}/assets`
