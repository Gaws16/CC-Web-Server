const { EventEmitter } = require('events')

class LogBus extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(100)
  }

  push(entry) {
    const log = {
      ts: Date.now(),
      source: entry.source || 'server',
      level: entry.level || 'info',
      event: entry.event || 'log',
      message: entry.message || '',
      meta: entry.meta || null
    }
    this.emit('log', log)
  }
}

module.exports = new LogBus()
