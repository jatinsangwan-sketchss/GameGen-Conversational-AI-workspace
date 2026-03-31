import { API_BASE_URL } from '../config/api.config'

export async function generateBlueprint({ prdText, sessionId }) {
  const res = await fetch(`${API_BASE_URL}/api/game-build/blueprint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prdText, sessionId })
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Generate blueprint failed: ${res.status} ${text}`)
  }

  return res.json()
}

export async function startGameBuild({ sessionId, blueprint }) {
  const res = await fetch(`${API_BASE_URL}/api/game-build/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, blueprint })
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Start build failed: ${res.status} ${text}`)
  }

  return res.json()
}
