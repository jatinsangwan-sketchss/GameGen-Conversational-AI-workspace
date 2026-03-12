import { createSession } from "../domain/Session.js"

export class SessionRepository {
  constructor() {
    this.sessions = new Map()
  }

  get(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, createSession())
    }
    return this.sessions.get(sessionId)
  }

  has(sessionId) {
    return this.sessions.has(sessionId)
  }

  delete(sessionId) {
    this.sessions.delete(sessionId)
  }
}

export const sessionRepository = new SessionRepository()
