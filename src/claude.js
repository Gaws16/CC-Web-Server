const { spawn } = require('child_process')

const STDERR_SENSITIVE = /\/Users\/[^\s]+|\/home\/[^\s]+|key|token|secret/gi

function sanitiseStderr(raw) {
  if (!raw) return 'Unknown error'
  return raw.slice(0, 200).replace(STDERR_SENSITIVE, '[redacted]')
}

// SSE helpers
function sseToken(res, text) {
  res.write(`data: ${JSON.stringify({ type: 'token', text })}\n\n`)
}

function sseDone(res, sessionId, clientId) {
  res.write(`data: ${JSON.stringify({ type: 'done', sessionId, clientId })}\n\n`)
  res.end()
}

function sseError(res, code, message) {
  res.write(`data: ${JSON.stringify({ type: 'error', code, message })}\n\n`)
  res.end()
}

function sseHeartbeat(res) {
  res.write(': heartbeat\n\n')
}

function runClaude({ message, systemPrompt, sessionId, model, timeoutMs, onToken, onDone, onError }) {
  const args = ['-p', message, '--output-format', 'stream-json', '--verbose']
  if (sessionId) args.push('--resume', sessionId)
  if (systemPrompt) args.push('--system-prompt', systemPrompt)
  if (model) args.push('--model', model)

  const child = spawn('claude', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  })

  let stderr = ''
  let newSessionId = null
  let gotOutput = false
  let finished = false
  let lineBuffer = ''

  function finish(cb) {
    if (finished) return
    finished = true
    cb()
  }

  // Parse NDJSON lines from stdout
  child.stdout.on('data', (chunk) => {
    lineBuffer += chunk.toString()
    const lines = lineBuffer.split('\n')
    lineBuffer = lines.pop() // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }

      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            gotOutput = true
            onToken(block.text)
          }
        }
      }

      if (event.type === 'result') {
        newSessionId = event.session_id || null
        if (event.result && !gotOutput) {
          gotOutput = true
          onToken(event.result)
        }
      }
    }
  })

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  child.on('close', (code) => {
    // Flush remaining buffer
    if (lineBuffer.trim()) {
      try {
        const event = JSON.parse(lineBuffer)
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              gotOutput = true
              onToken(block.text)
            }
          }
        }
        if (event.type === 'result') {
          newSessionId = event.session_id || null
          if (event.result && !gotOutput) {
            gotOutput = true
            onToken(event.result)
          }
        }
      } catch {}
    }

    if (stderr.includes('not authenticated')) {
      return finish(() => onError(500, 'claude not authenticated'))
    }
    if (code !== 0) {
      return finish(() => onError(500, sanitiseStderr(stderr)))
    }
    if (!gotOutput) {
      return finish(() => onError(500, 'CC returned no output'))
    }
    finish(() => onDone(newSessionId))
  })

  child.on('error', (err) => {
    finish(() => onError(500, err.message))
  })

  // Timeout handling
  const timer = setTimeout(() => {
    child.kill('SIGTERM')
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL')
    }, 2000)
    finish(() => onError(504, 'CC process timed out'))
  }, timeoutMs)

  child.on('close', () => clearTimeout(timer))

  return child
}

module.exports = { runClaude, sseToken, sseDone, sseError, sseHeartbeat }
