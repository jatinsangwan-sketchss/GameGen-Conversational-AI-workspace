import { randomUUID } from "node:crypto";

function safeString(value) {
  return value == null ? "" : String(value);
}

function clone(value) {
  if (value == null) return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function normalizeSessionId(sessionId) {
  const v = safeString(sessionId).trim();
  return v || null;
}

function normalizeProjectPath(projectPath) {
  const v = safeString(projectPath).trim();
  return v || null;
}

function makeRecord({ sessionId, projectPath = null }) {
  const now = new Date().toISOString();
  return {
    sessionId,
    projectPath: normalizeProjectPath(projectPath),
    runMode: null,
    createdAt: now,
    updatedAt: now,
    lastRunResult: null,
  };
}

export class GenericMcpSessionStore {
  constructor({ maxSessions = 200 } = {}) {
    const n = Number(maxSessions);
    this._maxSessions = Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
    this._sessions = new Map();
  }

  ensureSession(sessionId = null, { projectPath = null } = {}) {
    const existingId = normalizeSessionId(sessionId);
    const id = existingId || randomUUID();
    const prev = this._sessions.get(id);
    const record = prev ?? makeRecord({ sessionId: id, projectPath });

    if (projectPath != null) {
      record.projectPath = normalizeProjectPath(projectPath);
    }
    record.updatedAt = new Date().toISOString();

    this._touch(id, record);
    this._evictOverflow();
    return clone(record);
  }

  getSession(sessionId) {
    const id = normalizeSessionId(sessionId);
    if (!id) return null;
    const record = this._sessions.get(id);
    if (!record) return null;
    record.updatedAt = new Date().toISOString();
    this._touch(id, record);
    return clone(record);
  }

  setRunResult(sessionId, runResult, { projectPath = null, runMode = null } = {}) {
    const rec = this.ensureSession(sessionId, { projectPath });
    const id = rec.sessionId;
    const next = this._sessions.get(id);
    if (!next) return null;

    next.lastRunResult = clone(runResult);
    if (projectPath != null) {
      next.projectPath = normalizeProjectPath(projectPath);
    }
    if (runMode != null) {
      const mode = safeString(runMode).trim().toLowerCase();
      next.runMode = mode || null;
    }
    next.updatedAt = new Date().toISOString();
    this._touch(id, next);
    return clone(next);
  }

  getSummary() {
    return {
      totalSessions: this._sessions.size,
      maxSessions: this._maxSessions,
      activeSessionIds: Array.from(this._sessions.keys()),
    };
  }

  _touch(sessionId, record) {
    this._sessions.delete(sessionId);
    this._sessions.set(sessionId, record);
  }

  _evictOverflow() {
    while (this._sessions.size > this._maxSessions) {
      const oldest = this._sessions.keys().next().value;
      if (!oldest) break;
      this._sessions.delete(oldest);
    }
  }
}
