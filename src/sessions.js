const MAX_SESSIONS = 100

const sessions = new Map()

function get(clientId) {
  const entry = sessions.get(clientId)
  if (!entry) return null
  entry.lastUsedAt = Date.now()
  return entry
}

function set(clientId, sessionId) {
  // Evict oldest if at capacity
  if (!sessions.has(clientId) && sessions.size >= MAX_SESSIONS) {
    let oldest = null
    for (const [key, val] of sessions) {
      if (!oldest || val.lastUsedAt < oldest.lastUsedAt) {
        oldest = { key, lastUsedAt: val.lastUsedAt }
      }
    }
    if (oldest) sessions.delete(oldest.key)
  }

  sessions.set(clientId, {
    sessionId,
    createdAt: sessions.get(clientId)?.createdAt || Date.now(),
    lastUsedAt: Date.now()
  })
}

function del(clientId) {
  return sessions.delete(clientId)
}

function all() {
  const result = {}
  for (const [key, val] of sessions) {
    result[key] = val
  }
  return result
}

module.exports = { get, set, delete: del, all }
