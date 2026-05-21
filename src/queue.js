class RequestQueue {
  constructor(maxDepth = 10, maxConcurrent = 1) {
    this.maxDepth = maxDepth
    this.maxConcurrent = maxConcurrent
    this.pending = []
    this.running = 0
  }

  get depth() {
    return this.pending.length + this.running
  }

  get active() {
    return this.running
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

  // Drain pending jobs up to maxConcurrent slots. Each settled job frees its
  // slot and re-drains, so a finished job immediately admits a waiting one.
  _process() {
    while (this.running < this.maxConcurrent && this.pending.length > 0) {
      const next = this.pending.shift()
      this.running++
      Promise.resolve()
        .then(next.jobFn)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.running--
          this._process()
        })
    }
  }
}

module.exports = RequestQueue
