import { useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE_URL } from '../config/api.config'

const statusColors = {
  idle: '#64748b',
  queued: '#f59e0b',
  building: '#3b82f6',
  completed: '#22c55e',
  error: '#ef4444'
}

function formatTimestamp(value) {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString()
}

export default function GameBuildPanel({ sessionId = 'default', blueprint }) {
  const [buildStatus, setBuildStatus] = useState('idle')
  const [logs, setLogs] = useState([])
  const [reasoning, setReasoning] = useState([])
  const logEndRef = useRef(null)
  const reasoningEndRef = useRef(null)

  const statusLabel = useMemo(() => {
    if (buildStatus === 'idle') return 'Idle'
    if (buildStatus === 'queued') return 'Queued'
    if (buildStatus === 'building') return 'Building'
    if (buildStatus === 'completed') return 'Completed'
    if (buildStatus === 'error') return 'Error'
    return buildStatus
  }, [buildStatus])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  useEffect(() => {
    reasoningEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [reasoning])

  useEffect(() => {
    const url = `${API_BASE_URL}/api/game-build/stream?sessionId=${encodeURIComponent(sessionId)}`
    const eventSource = new EventSource(url)

    eventSource.addEventListener('log', (event) => {
      try {
        const payload = JSON.parse(event.data)
        setLogs((prev) => [...prev, payload])
      } catch {
        setLogs((prev) => [
          ...prev,
          { level: 'INFO', message: event.data, timestamp: new Date().toISOString() }
        ])
      }
    })

    eventSource.addEventListener('reasoning', (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (!payload?.chunk) return
        setReasoning((prev) => [...prev, payload])
      } catch {
        setReasoning((prev) => [
          ...prev,
          { chunk: event.data, timestamp: new Date().toISOString() }
        ])
      }
    })

    eventSource.addEventListener('status', (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (payload?.status) {
          setBuildStatus(payload.status)
        }
      } catch {
        // ignore
      }
    })

    eventSource.onerror = () => {
      setBuildStatus((prev) => (prev === 'building' ? prev : 'error'))
    }

    return () => {
      eventSource.close()
    }
  }, [sessionId])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: '20px', height: '100%' }}>
      <div style={{
        border: '1px solid #2a2a2a',
        borderRadius: '12px',
        background: '#111111',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '14px', color: '#e5e7eb', fontWeight: 600 }}>
            Build Logs
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '12px',
            color: statusColors[buildStatus] || '#94a3b8'
          }}>
            <span style={{
              width: '8px',
              height: '8px',
              borderRadius: '999px',
              background: statusColors[buildStatus] || '#94a3b8'
            }} />
            {statusLabel}
          </div>
        </div>

        <div style={{
          border: '1px solid #1f2937',
          borderRadius: '10px',
          background: '#05070d',
          padding: '12px',
          overflowY: 'auto',
          fontSize: '12px',
          color: '#e5e7eb',
          maxHeight: '220px'
        }}>
          {reasoning.length === 0 ? (
            <div style={{ color: '#64748b' }}>Reasoning will appear here during PRD analysis.</div>
          ) : (
            reasoning.map((item, index) => (
              <div key={`${item.timestamp}-${index}`} style={{ marginBottom: '6px' }}>
                <span style={{ color: '#94a3b8', marginRight: '6px' }}>
                  [{formatTimestamp(item.timestamp)}]
                </span>
                <span style={{ color: '#facc15', marginRight: '6px' }}>[AI]</span>
                <span>{item.chunk}</span>
              </div>
            ))
          )}
          <div ref={reasoningEndRef} />
        </div>

        <div style={{
          flex: 1,
          border: '1px solid #1f2937',
          borderRadius: '10px',
          background: '#05070d',
          padding: '12px',
          overflowY: 'auto',
          fontSize: '12px',
          color: '#e5e7eb'
        }}>
          {logs.length === 0 ? (
            <div style={{ color: '#64748b' }}>Logs will appear here once the build starts.</div>
          ) : (
            logs.map((log, index) => (
              <div key={`${log.timestamp}-${index}`} style={{ marginBottom: '6px' }}>
                <span style={{ color: '#94a3b8', marginRight: '6px' }}>
                  [{formatTimestamp(log.timestamp)}]
                </span>
                <span style={{ color: '#38bdf8', marginRight: '6px' }}>
                  [{log.level || 'INFO'}]
                </span>
                <span>{log.message}</span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </div>

      <div style={{
        border: '1px solid #2a2a2a',
        borderRadius: '12px',
        background: '#111111',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}>
        <div style={{ fontSize: '14px', color: '#e5e7eb', fontWeight: 600 }}>
          Game Blueprint
        </div>
        <pre style={{
          flex: 1,
          margin: 0,
          background: '#0b1220',
          borderRadius: '10px',
          border: '1px solid rgba(148,163,184,0.2)',
          padding: '12px',
          color: '#cbd5f5',
          fontSize: '12px',
          overflow: 'auto'
        }}>
          {blueprint ? JSON.stringify(blueprint, null, 2) : 'Blueprint preview will appear here.'}
        </pre>
      </div>
    </div>
  )
}
