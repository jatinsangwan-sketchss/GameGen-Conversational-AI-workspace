// sessions/store.js
export const sessions = new Map()

export function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { artifacts: [] })
  }
  return sessions.get(sessionId)
}

export function checkSession(sessionId){
  if(!sessions.has(sessionId))return false;
  return true;
}