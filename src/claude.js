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
  const args = ['-p', '--output-format', 'stream-json', '--verbose']
  if (sessionId) args.push('--resume', sessionId)
  if (systemPrompt) args.push('--system-prompt', systemPrompt)
  if (model) args.push('--model', model)

  // Prompt is piped via stdin (not argv) so payloads >ARG_MAX don't fail with E2BIG.
  const child = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
  })
  child.stdin.on('error', () => {})
  child.stdin.end(message)

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

// SSE helpers for tool endpoint
function sseTextDelta(res, text) {
  res.write(`data: ${JSON.stringify({ type: 'text_delta', text })}\n\n`)
}

function sseToolStart(res, tool, input) {
  res.write(`data: ${JSON.stringify({ type: 'tool_start', tool, input })}\n\n`)
}

function sseToolResult(res, tool, result) {
  res.write(`data: ${JSON.stringify({ type: 'tool_result', tool, result })}\n\n`)
}

function sseToolDone(res) {
  res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
  res.end()
}

function runClaudeWithTools({ message, systemPrompt, mcpConfigPath, allowedTools, model, timeoutMs, onTextDelta, onToolStart, onToolResult, onDone, onError }) {
  const prompt = systemPrompt ? `${systemPrompt}\n\n${message}` : message
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '']
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath)
  if (allowedTools) args.push('--allowedTools', allowedTools)
  if (model) args.push('--model', model)

  // Prompt is piped via stdin (not argv) so payloads >ARG_MAX don't fail with E2BIG.
  const child = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
  })
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)

  let stderr = ''
  let gotOutput = false
  let finished = false
  let lineBuffer = ''

  // Track tool calls to map tool_use IDs to tool names
  const toolCalls = {}

  function finish(cb) {
    if (finished) return
    finished = true
    cb()
  }

  function processEvent(event) {
    // Debug: log every event type to understand Claude CLI's stream format
    const debugInfo = { type: event.type, subtype: event.subtype }
    if (event.message?.content) {
      debugInfo.blockTypes = event.message.content.map(b => b.type)
    }
    if (event.tool_name || event.name) debugInfo.toolName = event.tool_name || event.name
    console.log('[mcp-debug]', JSON.stringify(debugInfo))

    // Assistant message — contains text blocks and tool_use blocks
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          gotOutput = true
          onTextDelta(block.text)
        }
        if (block.type === 'tool_use') {
          gotOutput = true
          // Strip mcp__db__ prefix for cleaner tool names
          const toolName = (block.name || '').replace(/^mcp__db__/, '')
          toolCalls[block.id] = toolName
          onToolStart(toolName, block.input || {})
        }
      }
    }

    // Tool result events
    if (event.type === 'tool_result' || (event.type === 'system' && event.subtype === 'tool_result')) {
      const toolName = toolCalls[event.tool_use_id] || event.tool_name || 'unknown'
      const resultText = typeof event.content === 'string' ? event.content :
        Array.isArray(event.content) ? event.content.map(c => c.text || '').join('') :
        JSON.stringify(event.content || event.result || '')
      onToolResult(toolName, resultText)
    }

    // Result event — process complete
    if (event.type === 'result') {
      if (event.result && !gotOutput) {
        gotOutput = true
        onTextDelta(event.result)
      }
    }
  }

  child.stdout.on('data', (chunk) => {
    lineBuffer += chunk.toString()
    const lines = lineBuffer.split('\n')
    lineBuffer = lines.pop()

    for (const line of lines) {
      if (!line.trim()) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      processEvent(event)
    }
  })

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  child.on('close', (code) => {
    // Flush remaining buffer
    if (lineBuffer.trim()) {
      try {
        processEvent(JSON.parse(lineBuffer))
      } catch {}
    }

    if (stderr.includes('not authenticated')) {
      return finish(() => onError(500, 'claude not authenticated'))
    }
    if (code !== 0 && code !== null) {
      return finish(() => onError(500, sanitiseStderr(stderr)))
    }
    if (!gotOutput) {
      return finish(() => onError(500, 'CC returned no output'))
    }
    finish(() => onDone())
  })

  child.on('error', (err) => {
    finish(() => onError(500, err.message))
  })

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

module.exports = { runClaude, runClaudeWithTools, sseToken, sseDone, sseError, sseHeartbeat, sseTextDelta, sseToolStart, sseToolResult, sseToolDone }
