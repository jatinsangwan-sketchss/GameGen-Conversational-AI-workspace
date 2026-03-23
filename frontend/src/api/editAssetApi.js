import { API_BASE_URL } from '../config/api.config'

export async function editAsset(payload) {
  const res = await fetch(`${API_BASE_URL}/api/edit-asset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Edit asset failed: ${res.status} ${text}`)
  }

  return res.json()
}
