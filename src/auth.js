const { timingSafeEqual } = require('crypto')

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const token = header.slice(7)
  const clientsJson = process.env.API_CLIENTS

  if (clientsJson) {
    let clients
    try {
      clients = JSON.parse(clientsJson)
    } catch {
      console.error('Invalid API_CLIENTS JSON')
      return res.status(500).json({ error: 'Server misconfigured' })
    }

    for (const [clientId, secret] of Object.entries(clients)) {
      if (safeEqual(token, secret)) {
        req.clientId = clientId
        return next()
      }
    }
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (safeEqual(token, process.env.API_SECRET || '')) {
    req.clientId = req.body?.clientId || 'default'
    return next()
  }

  return res.status(401).json({ error: 'Unauthorized' })
}

module.exports = authMiddleware
