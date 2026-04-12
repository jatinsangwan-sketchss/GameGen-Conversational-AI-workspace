
import { useState, useRef, useEffect } from 'react'
import { NexverseLogo, nexverseFont } from './Logo'
import LayoutWorkspace from './components/LayoutWorkspace'
import GameBuildPanel from './components/GameBuildPanel'
import { API_BASE_URL } from './config/api.config'
import { generateBlueprint, startGameBuild } from './api/gameBuildApi'
import { commitDraft, regenerateDraft } from './api/draftAssetsApi'

// Color theme constants
const colors = {
  background: '#0a0a0a',
  surface: '#1a1a1a',
  surfaceElevated: '#252525',
  border: '#333333',
  borderLight: '#2a2a2a',
  text: '#e0e0e0',
  textSecondary: '#a0a0a0',
  textMuted: '#666666',
  accent: '#ffffff',
  accentBlue: '#3b82f6',
  accentBlueHover: '#2563eb',
  inputBg: '#1f1f1f',
  cardBg: '#1f1f1f',
  success: '#10b981',
  error: '#ef4444'
}

// Legacy artifact renderer removed for asset-first UI

const WORKSPACE_STORAGE_KEY = 'nexverse_workspace_v1'

function loadWorkspaceSnapshot() {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch (err) {
    console.warn('Failed to load workspace snapshot:', err)
    return null
  }
}

function saveWorkspaceSnapshot(snapshot) {
  try {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(snapshot))
  } catch (err) {
    console.warn('Failed to save workspace snapshot:', err)
  }
}

function WorkspaceGeneratingCard() {
  return (
    <>
      <style>{`
        @keyframes nvShimmer {
          0% { transform: translateX(-60%); opacity: 0.15; }
          50% { opacity: 0.35; }
          100% { transform: translateX(60%); opacity: 0.15; }
        }
        @keyframes nvPulse {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 1; }
        }
      `}</style>
      <div style={{
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        backgroundColor: colors.surfaceElevated,
        overflow: 'hidden'
      }}>
        <div style={{
          padding: '14px 16px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: colors.surfaceElevated
        }}>
          <div style={{
            fontFamily: nexverseFont,
            fontWeight: 700,
            letterSpacing: '1px',
            textTransform: 'uppercase',
            color: colors.text
          }}>
            Generating UI…
          </div>
          <div style={{
            fontFamily: nexverseFont,
            fontSize: '0.8em',
            color: colors.textMuted,
            letterSpacing: '0.5px',
            animation: 'nvPulse 1.2s ease-in-out infinite'
          }}>
            Rendering image
          </div>
        </div>

        <div style={{
          padding: '20px',
          display: 'flex',
          justifyContent: 'center',
          backgroundColor: colors.surface
        }}>
          <div style={{
            width: '375px',
            maxWidth: '100%',
            aspectRatio: '9 / 16',
            backgroundColor: '#000',
            borderRadius: '24px',
            padding: '8px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            position: 'relative'
          }}>
            <div style={{
              width: '100%',
              height: '100%',
              borderRadius: '16px',
              overflow: 'hidden',
              backgroundColor: colors.background,
              position: 'relative',
              border: `1px solid ${colors.border}`
            }}>
              <div style={{
                position: 'absolute',
                inset: 0,
                background: `linear-gradient(90deg, ${colors.surface} 0%, ${colors.surfaceElevated} 40%, ${colors.surface} 80%)`
              }} />
              <div style={{
                position: 'absolute',
                inset: 0,
                background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.18) 50%, transparent 100%)',
                transform: 'translateX(-60%)',
                animation: 'nvShimmer 1.4s ease-in-out infinite'
              }} />

              {/* Minimal “content hints” */}
              <div style={{ position: 'absolute', inset: 0, padding: '18px' }}>
                <div style={{
                  height: '26px',
                  width: '70%',
                  borderRadius: '10px',
                  backgroundColor: colors.surfaceElevated,
                  border: `1px solid ${colors.border}`,
                  marginBottom: '14px'
                }} />
                <div style={{
                  height: '16px',
                  width: '45%',
                  borderRadius: '8px',
                  backgroundColor: colors.surfaceElevated,
                  border: `1px solid ${colors.border}`,
                  marginBottom: '22px'
                }} />
                <div style={{
                  height: '44px',
                  width: '100%',
                  borderRadius: '12px',
                  backgroundColor: colors.surfaceElevated,
                  border: `1px solid ${colors.border}`,
                  marginBottom: '12px'
                }} />
                <div style={{
                  height: '44px',
                  width: '100%',
                  borderRadius: '12px',
                  backgroundColor: colors.surfaceElevated,
                  border: `1px solid ${colors.border}`,
                  marginBottom: '18px'
                }} />
                <div style={{
                  height: '48px',
                  width: '100%',
                  borderRadius: '14px',
                  backgroundColor: colors.accentBlue,
                  opacity: 0.35
                }} />
              </div>
            </div>

            <div style={{
              position: 'absolute',
              bottom: '4px',
              left: '50%',
              transform: 'translateX(-50%)',
              width: '134px',
              height: '5px',
              backgroundColor: 'rgba(255,255,255,0.3)',
              borderRadius: '3px'
            }} />
          </div>
        </div>
      </div>
    </>
  )
}

export default function App() {
  const [messages, setMessages] = useState([])
  const [screens, setScreens] = useState([])
  const [assets, setAssets] = useState({})
  const [layoutByScreen, setLayoutByScreen] = useState({})
  const [designContext, setDesignContext] = useState(null)
  const [workspaceMode, setWorkspaceMode] = useState('layout')
  const [gameBlueprint, setGameBlueprint] = useState(null)
  const [pendingBuild, setPendingBuild] = useState(null)
  const [isStartingBuild, setIsStartingBuild] = useState(false)
  const [saveNotice, setSaveNotice] = useState('')
  const saveNoticeTimer = useRef(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [draftAssets, setDraftAssets] = useState({})
  const [summaryLine, setSummaryLine] = useState('')
  const summaryEventRef = useRef(null)
  const [approvingDraftIds, setApprovingDraftIds] = useState({})
  const messagesEndRef = useRef(null)
  const chatContainerRef = useRef(null)
  const persistTimerRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  useEffect(() => {
    const snapshot = loadWorkspaceSnapshot()
    if (!snapshot) return
    if (Array.isArray(snapshot.messages)) {
      setMessages(snapshot.messages)
    }
    if (Array.isArray(snapshot.screens)) {
      setScreens(snapshot.screens)
    }
    if (snapshot.assets && typeof snapshot.assets === 'object') {
      setAssets(snapshot.assets)
    }
    if (snapshot.layoutByScreen && typeof snapshot.layoutByScreen === 'object') {
      setLayoutByScreen(snapshot.layoutByScreen)
    }
    if (typeof snapshot.designContext === 'string') {
      setDesignContext(snapshot.designContext)
    }
    if (snapshot.draftAssets && typeof snapshot.draftAssets === 'object') {
      setDraftAssets(snapshot.draftAssets)
    }
    if (typeof snapshot.workspaceMode === 'string') {
      setWorkspaceMode(snapshot.workspaceMode)
    }
    if (snapshot.gameBlueprint && typeof snapshot.gameBlueprint === 'object') {
      setGameBlueprint(snapshot.gameBlueprint)
    }
  }, [])

  useEffect(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current)
    }
    persistTimerRef.current = setTimeout(() => {
      saveWorkspaceSnapshot({
        messages,
        screens,
        assets,
        layoutByScreen,
        designContext,
        workspaceMode,
        gameBlueprint,
        draftAssets
      })
    }, 300)

    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
      }
    }
  }, [messages, screens, assets, layoutByScreen, designContext])

  useEffect(() => {
    const url = `${API_BASE_URL}/api/assets/summary/stream?sessionId=default`
    const source = new EventSource(url)
    summaryEventRef.current = source
    source.addEventListener('summary', (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (payload?.chunk) {
          setSummaryLine(payload.chunk)
          if (payload.final) {
            setMessages((m) => [...m, { role: 'assistant', content: payload.chunk }])
            setSummaryLine('')
          }
        }
      } catch {
        // ignore
      }
    })
    return () => source.close()
  }, [])

  async function sendMessage() {
    if (!input.trim() || loading) return

    const userMessage = input.trim()
    setInput('')
    setLoading(true)

    // Add user message immediately
    setMessages(m => [...m, { role: 'user', content: userMessage }])

    try {
      if (workspaceMode === 'game-build') {
        setMessages(m => [...m, { role: 'assistant', content: 'Analyzing game PRD...' }])
        const response = await generateBlueprint({ prdText: userMessage, sessionId: 'default' })
        const blueprint = response?.blueprint || response
        setGameBlueprint(blueprint)
        setPendingBuild({ prdText: userMessage, blueprint })
        setMessages(m => [
          ...m,
          {
            role: 'assistant',
            type: 'build_prompt',
            content: 'Blueprint ready. Start build?'
          }
        ])
        return
      }

      const res = await fetch(`${API_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: userMessage,
          sessionId: 'default' 
        })
      })

      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`)
      }

      const data = await res.json()

      // Add assistant message
      setMessages(m => [...m, { role: 'assistant', content: data.chat || 'Response received' }])

      if (Array.isArray(data.screens)) {
        setScreens(data.screens)
      }
      if (data.assets && typeof data.assets === 'object') {
        setAssets(data.assets)
      }
      if (data.draftAssets && typeof data.draftAssets === 'object') {
        console.log('[draftAssets] received', data.draftAssets)
        setDraftAssets(data.draftAssets)
      }
      if (typeof data.designContext === 'string') {
        setDesignContext(data.designContext)
      }
    } catch (error) {
      console.error('Error sending message:', error)
      setMessages(m => [...m, { 
        role: 'assistant', 
        content: 'Sorry, I encountered an error. Please check your backend connection and try again.' 
      }])
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirmBuild() {
    if (!pendingBuild || isStartingBuild) return
    setIsStartingBuild(true)
    try {
      await startGameBuild({ sessionId: 'default', blueprint: pendingBuild.blueprint })
      setMessages(m => [...m, { role: 'assistant', content: 'Build started. Streaming logs on the right.' }])
      setPendingBuild(null)
    } catch (error) {
      console.error('Error starting build:', error)
      setMessages(m => [...m, { role: 'assistant', content: 'Failed to start build. Please try again.' }])
    } finally {
      setIsStartingBuild(false)
    }
  }

  function handleCancelBuild() {
    setPendingBuild(null)
    setMessages(m => [...m, { role: 'assistant', content: 'Build cancelled. Send a new PRD when ready.' }])
  }

  function handleAnnotationLog({ assetName, instruction }) {
    const summary = `Annotate: ${assetName}\nInstruction: ${instruction}`
    setMessages(m => [...m, { role: 'user', content: summary }])
  }

  function handleKeyPress(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  function clearChat() {
    setMessages([])
    setScreens([])
    setAssets({})
    setDesignContext(null)
    setLayoutByScreen({})
    setDraftAssets({})
    setGameBlueprint(null)
    setPendingBuild(null)
    setWorkspaceMode('layout')
    window.localStorage.removeItem(WORKSPACE_STORAGE_KEY)
    fetch(`${API_BASE_URL}/api/chat/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'default' })
    }).catch(console.error)
  }

  async function handleApproveDraft(draft) {
    if (approvingDraftIds[draft.id]) return
    setApprovingDraftIds((prev) => ({ ...prev, [draft.id]: true }))
    const screenName = draft.screenName
    const assetMeta = {
      id: draft.id.replace(/_draft$/, ""),
      type: draft?.componentSpec?.type || 'asset',
      label: draft?.componentSpec?.label || null
    }
    const res = await commitDraft({
      screenName,
      draftId: draft.id,
      assetMeta,
      sessionId: 'default'
    })
    if (res?.assets) {
      setAssets(res.assets)
      setDraftAssets((prev) => ({
        ...prev,
        [screenName]: (prev[screenName] || []).filter((item) => item.id !== draft.id)
      }))
    }
    setApprovingDraftIds((prev) => {
      const next = { ...prev }
      delete next[draft.id]
      return next
    })
  }

  async function handleRegenerateDraft(draft) {
    const screenName = draft.screenName
    const instructions = window.prompt('Regenerate instructions', '') || ''
    const res = await regenerateDraft({
      screenName,
      instructions,
      sessionId: 'default'
    })
    if (res?.draftAssets) {
      setDraftAssets(res.draftAssets)
    }
  }

  function handleLayoutSaved(message) {
    setSaveNotice(message)
    if (saveNoticeTimer.current) {
      clearTimeout(saveNoticeTimer.current)
    }
    saveNoticeTimer.current = setTimeout(() => setSaveNotice(''), 2000)
  }

  return (
    <div style={{ 
      display: 'flex', 
      height: '100vh', 
      fontFamily: '"Inter", "SF Pro Text", "SF Pro Display", "Segoe UI", system-ui, sans-serif',
      overflow: 'hidden',
      backgroundColor: colors.background,
      color: colors.text
    }}>
      {/* Left Panel - Chat */}
      <div style={{ 
        width: '40%', 
        borderRight: `1px solid ${colors.border}`, 
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: colors.surface
      }}>
        <div style={{ 
          padding: '20px', 
          borderBottom: `1px solid ${colors.border}`,
          backgroundColor: colors.surfaceElevated,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <NexverseLogo size={32} dark={false} showText={true} />
            <div style={{ 
              fontSize: '18px', 
              fontWeight: '700', 
              color: colors.text,
              letterSpacing: '1px',
              marginLeft: '4px',
              fontFamily: nexverseFont
            }}>
              NEXVERSE
            </div>
          </div>
          {messages.length > 0 && (
            <button
              onClick={clearChat}
              style={{
                padding: '8px 14px',
                border: `1px solid ${colors.border}`,
                borderRadius: '6px',
                backgroundColor: colors.surface,
                color: colors.textSecondary,
                cursor: 'pointer',
                fontSize: '0.85em',
                fontWeight: '500',
                transition: 'all 0.2s',
                ':hover': {
                  backgroundColor: colors.surfaceElevated
                }
              }}
              onMouseEnter={(e) => {
                e.target.style.backgroundColor = colors.surfaceElevated
                e.target.style.color = colors.text
              }}
              onMouseLeave={(e) => {
                e.target.style.backgroundColor = colors.surface
                e.target.style.color = colors.textSecondary
              }}
            >
              CLEAR
            </button>
          )}
        </div>
        
        <div 
          ref={chatContainerRef}
          style={{ 
            flex: 1, 
            overflowY: 'auto', 
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            backgroundColor: colors.surface
          }}
        >
          {messages.length === 0 && (
            <div style={{ 
              color: colors.textSecondary, 
              textAlign: 'center', 
              marginTop: '60px',
              padding: '20px'
            }}>
              <div style={{ fontSize: '48px', marginBottom: '16px' }}>👋</div>
              <div style={{ 
                fontSize: '18px', 
                color: colors.text, 
                marginBottom: '8px',
                fontWeight: '600',
                fontFamily: nexverseFont
              }}>
                Welcome to Nexverse
              </div>
              <div style={{ 
                fontSize: '14px', 
                marginTop: '12px', 
                color: colors.textMuted, 
                lineHeight: '1.6',
                fontFamily: nexverseFont
              }}>
                Transform ideas into reality with AI<br />
                <span style={{ color: colors.textSecondary, fontSize: '13px' }}>
                  Try: "Create a login screen UI spec" or "Generate a dashboard"
                </span>
              </div>
            </div>
          )}
          {messages.map((m, i) => {
            if (m.type === 'build_prompt') {
              return (
                <div
                  key={i}
                  style={{
                    alignSelf: 'flex-start',
                    maxWidth: '85%',
                    padding: '12px 16px',
                    borderRadius: '12px',
                    backgroundColor: colors.surfaceElevated,
                    color: colors.text,
                    border: `1px solid ${colors.border}`,
                    boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                    fontSize: '14px',
                    lineHeight: '1.5',
                    fontFamily: nexverseFont
                  }}
                >
                  <div style={{ marginBottom: '10px' }}>{m.content}</div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={handleConfirmBuild}
                      disabled={isStartingBuild}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '8px',
                        border: 'none',
                        background: isStartingBuild ? colors.textMuted : colors.accentBlue,
                        color: '#fff',
                        fontWeight: 600,
                        cursor: isStartingBuild ? 'not-allowed' : 'pointer'
                      }}
                    >
                      ✅ Build
                    </button>
                    <button
                      onClick={handleCancelBuild}
                      disabled={isStartingBuild}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '8px',
                        border: `1px solid ${colors.border}`,
                        background: colors.surface,
                        color: colors.textSecondary,
                        fontWeight: 600,
                        cursor: isStartingBuild ? 'not-allowed' : 'pointer'
                      }}
                    >
                      ❌ Cancel
                    </button>
                  </div>
                </div>
              )
            }

            return (
              <div 
                key={i} 
                style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '80%',
                  padding: '12px 16px',
                  borderRadius: '12px',
                  backgroundColor: m.role === 'user' ? colors.accentBlue : colors.surfaceElevated,
                  color: m.role === 'user' ? '#fff' : colors.text,
                  border: m.role === 'assistant' ? `1px solid ${colors.border}` : 'none',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                  fontSize: '14px',
                  lineHeight: '1.5',
                  fontFamily: nexverseFont
                }}
              >
                {m.content}
              </div>
            )
          })}
          {summaryLine && (
            <div style={{
              alignSelf: 'flex-start',
              maxWidth: '80%',
              padding: '10px 14px',
              borderRadius: '10px',
              backgroundColor: '#0f172a',
              color: '#cbd5f5',
              border: `1px solid ${colors.border}`,
              fontSize: '12px',
              fontFamily: nexverseFont
            }}>
              {summaryLine}
            </div>
          )}
          {loading && (
            <div style={{
              alignSelf: 'flex-start',
              padding: '12px 16px',
              borderRadius: '12px',
              backgroundColor: colors.surfaceElevated,
              border: `1px solid ${colors.border}`,
              color: colors.textSecondary,
              fontSize: '14px',
              fontFamily: nexverseFont
            }}>
              Thinking...
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        
        <div style={{ 
          padding: '20px', 
          borderTop: `1px solid ${colors.border}`,
          backgroundColor: colors.surfaceElevated
        }}>
          <div style={{ display: 'flex', gap: '10px' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
              onKeyPress={handleKeyPress}
              disabled={loading}
              style={{ 
                flex: 1, 
                padding: '12px 16px',
                border: `1px solid ${colors.border}`,
                borderRadius: '8px',
                fontSize: '14px',
                backgroundColor: colors.inputBg,
                color: colors.text,
                outline: 'none',
                fontFamily: nexverseFont
              }}
              placeholder="Ask anything... (Press Enter to send)"
              onFocus={(e) => {
                e.target.style.borderColor = colors.accentBlue
              }}
              onBlur={(e) => {
                e.target.style.borderColor = colors.border
              }}
            />
            <button 
              onClick={sendMessage}
              disabled={loading || !input.trim()}
              style={{ 
                padding: '12px 24px',
                border: 'none',
                borderRadius: '8px',
                backgroundColor: loading || !input.trim() ? colors.textMuted : colors.accentBlue,
                color: '#fff',
                cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                fontWeight: '600',
                fontSize: '14px',
                transition: 'background-color 0.2s',
                fontFamily: nexverseFont,
                letterSpacing: '0.3px'
              }}
              onMouseEnter={(e) => {
                if (!loading && input.trim()) {
                  e.target.style.backgroundColor = colors.accentBlueHover
                }
              }}
              onMouseLeave={(e) => {
                if (!loading && input.trim()) {
                  e.target.style.backgroundColor = colors.accentBlue
                }
              }}
            >
              SEND
            </button>
          </div>
        </div>
      </div>

      {/* Right Panel - Layout Workspace */}
      <div style={{ 
        width: '60%', 
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: colors.background
      }}>
        <div style={{ 
          padding: '20px', 
          borderBottom: `1px solid ${colors.border}`,
          backgroundColor: colors.surfaceElevated,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <div>
            <h3 style={{ 
              margin: 0, 
              fontSize: '18px', 
              fontWeight: '700',
              color: colors.text,
              letterSpacing: '1px',
              fontFamily: nexverseFont,
              textTransform: 'uppercase'
            }}>
              {workspaceMode === 'game-build' ? 'Game Build Mode' : 'Layout Workspace'}
            </h3>
            {workspaceMode !== 'game-build' && screens.length > 0 && (
              <div style={{ 
                fontSize: '0.75em', 
                color: colors.textMuted, 
                marginTop: '4px',
                fontFamily: nexverseFont,
                letterSpacing: '0.5px'
              }}>
                {screens.length} screen{screens.length !== 1 ? 's' : ''} generated
              </div>
            )}
          </div>
          {saveNotice && (
            <div style={{
              background: '#111827',
              color: '#e5e7eb',
              border: `1px solid ${colors.border}`,
              padding: '8px 12px',
              borderRadius: '8px',
              fontSize: '12px',
              letterSpacing: '0.3px'
            }}>
              {saveNotice}
            </div>
          )}
          {workspaceMode !== 'game-build' ? (
            <button
              onClick={() => setWorkspaceMode('game-build')}
              style={{
                marginLeft: '12px',
                padding: '8px 12px',
                borderRadius: '8px',
                border: `1px solid ${colors.border}`,
                background: '#0f172a',
                color: '#f8fafc',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              🚀 Enter Game Build Mode
            </button>
          ) : (
            <button
              onClick={() => setWorkspaceMode('layout')}
              style={{
                marginLeft: '12px',
                padding: '8px 12px',
                borderRadius: '8px',
                border: `1px solid ${colors.border}`,
                background: colors.surface,
                color: colors.textSecondary,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Exit Game Build Mode
            </button>
          )}
        </div>
        
        <div style={{ 
          flex: 1, 
          overflowY: 'auto', 
          padding: '24px',
          backgroundColor: colors.background
        }}>
          {loading && (
            <div style={{ marginBottom: '24px' }}>
              <WorkspaceGeneratingCard />
            </div>
          )}
          {workspaceMode === 'game-build' ? (
            <GameBuildPanel sessionId="default" blueprint={gameBlueprint} />
          ) : screens.length === 0 && Object.keys(assets).length === 0 ? (
            <div style={{ 
              color: colors.textSecondary, 
              textAlign: 'center', 
              marginTop: '100px',
              padding: '20px'
            }}>
              <div style={{ fontSize: '64px', marginBottom: '24px' }}>🎨</div>
              <div style={{ 
                fontSize: '20px', 
                marginBottom: '12px',
                color: colors.text,
                fontWeight: '600',
                fontFamily: nexverseFont,
                letterSpacing: '0.5px'
              }}>
                Ready to Create
              </div>
              <div style={{ 
                fontSize: '14px', 
                color: colors.textMuted,
                lineHeight: '1.6',
                fontFamily: nexverseFont
              }}>
                Your generated artifacts will appear here<br />
                <span style={{ color: colors.textSecondary }}>
                  Start a conversation to see magic happen
                </span>
              </div>
            </div>
          ) : (
            <LayoutWorkspace
              screens={screens}
              assets={assets}
              layoutByScreen={layoutByScreen}
              setLayoutByScreen={setLayoutByScreen}
              onSaved={handleLayoutSaved}
              designContext={designContext}
              onAnnotationLog={handleAnnotationLog}
              draftAssets={draftAssets}
              onApproveDraft={handleApproveDraft}
              onRegenerateDraft={handleRegenerateDraft}
              approvingDraftIds={approvingDraftIds}
            />
          )}
        </div>
      </div>
    </div>
  )
}
