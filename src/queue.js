class RequestQueue {
  constructor(maxDepth = 10) {
    this.maxDepth = maxDepth
    this.pending = []
    this.running = false
  }

  get depth() {
    return this.pending.length + (this.running ? 1 : 0)
  }

  enqueue(jobFn) {
    return new Promise((resolve, reject) => {
      if (this.pending.length >= this.maxDepth) {
        return reject(new Error('Queue full'))
      }
      this.pending.push({ jobFn, resolve, reject })
      this._process()
    })
  }

  async _process() {
    if (this.running) return
    const next = this.pending.shift()
    if (!next) return

    this.running = true
    try {
      const result = await next.jobFn()
      next.resolve(result)
    } catch (err) {
      next.reject(err)
    } finally {
      this.running = false
      this._process()
    }
  }
}

module.exports = RequestQueue
