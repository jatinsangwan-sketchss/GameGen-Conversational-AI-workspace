import { sessionRepository } from "./repositories/SessionRepository.js"

export const sessions = sessionRepository.sessions

export function getSession(sessionId) {
  return sessionRepository.get(sessionId)
}

export function checkSession(sessionId) {
  return sessionRepository.has(sessionId)
}

export function deleteSession(sessionId) {
  sessionRepository.delete(sessionId)
}

// /assets/<game_name>/<screen_name>/<png file> ------ this is the folder structure for our assets

// {
//   designContext: null,
//   originalPRD: null,
//   screensMetadata: [],
//   assets: {},
//   gameName: null
// }