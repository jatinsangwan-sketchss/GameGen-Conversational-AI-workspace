import { API_BASE_URL } from '../config/api.config'

export async function regenerateDraft({ screenName, instructions, sessionId }) {
  const res = await fetch(`${API_BASE_URL}/api/assets/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ screenName, instructions, sessionId })
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Regenerate draft failed: ${res.status} ${text}`)
  }
  return res.json()
}

export async function commitDraft({ screenName, draftId, assetMeta, sessionId }) {
  const res = await fetch(`${API_BASE_URL}/api/assets/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ screenName, draftId, assetMeta, sessionId })
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Commit draft failed: ${res.status} ${text}`)
  }
  return res.json()
}
