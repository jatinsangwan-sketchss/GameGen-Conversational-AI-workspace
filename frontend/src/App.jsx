
import { useState, useRef, useEffect } from 'react'
import { NexverseLogo, nexverseFont } from './Logo'
import AnnotatableImage from './AnnotatableImage'

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

// Artifact Renderer Components
function UISpecRenderer({ artifact }) {
  const { content } = artifact
  const renderComponent = (comp, index) => {
    const key = `${comp.type}-${index}`
    const baseStyle = { marginBottom: '12px', padding: '0' }

    switch (comp.type) {
      case 'text':
        const textStyle = {
          ...baseStyle,
          fontSize: comp.style?.fontSize || '1em',
          fontWeight: comp.style?.fontWeight || '400',
          color: comp.style?.color || colors.text,
          fontFamily: nexverseFont
        }
        return <div key={key} style={textStyle}>{comp.value || comp.text}</div>
      
      case 'input':
        return (
          <div key={key} style={baseStyle}>
            <label style={{ 
              display: 'block', 
              marginBottom: '8px', 
              fontWeight: '600',
              color: colors.textSecondary,
              fontSize: '0.9em',
              fontFamily: nexverseFont,
              letterSpacing: '0.3px'
            }}>
              {comp.label}
              {comp.required && <span style={{ color: colors.error }}> *</span>}
            </label>
            <input
              type={comp.secure ? 'password' : 'text'}
              placeholder={comp.placeholder || ''}
              disabled
              style={{
                width: '100%',
                padding: '10px 12px',
                border: `1px solid ${colors.border}`,
                borderRadius: '6px',
                backgroundColor: colors.inputBg,
                color: colors.text,
                fontSize: '14px',
                fontFamily: nexverseFont
              }}
            />
          </div>
        )
      
      case 'button':
        const buttonStyle = {
          padding: '10px 20px',
          border: 'none',
          borderRadius: '6px',
          backgroundColor: comp.primary ? colors.accentBlue : comp.variant === 'text' ? 'transparent' : colors.surfaceElevated,
          color: comp.primary || comp.variant === 'text' ? (comp.variant === 'text' ? colors.text : '#fff') : colors.text,
          cursor: 'not-allowed',
          opacity: 0.7,
          fontWeight: '600',
          fontSize: '14px',
          fontFamily: nexverseFont,
          letterSpacing: '0.3px'
        }
        return (
          <button key={key} style={buttonStyle} disabled>
            {comp.label}
          </button>
        )
      
      case 'card':
        return (
          <div key={key} style={{
            ...baseStyle,
            border: `1px solid ${colors.border}`,
            borderRadius: '8px',
            padding: '16px',
            backgroundColor: colors.cardBg
          }}>
            <div style={{ 
              fontSize: '0.85em', 
              color: colors.textMuted, 
              marginBottom: '8px', 
              textTransform: 'uppercase', 
              letterSpacing: '1px',
              fontFamily: nexverseFont,
              fontWeight: '600'
            }}>
              {comp.title}
            </div>
            <div style={{ fontSize: '1.75em', fontWeight: '700', marginBottom: '6px', color: colors.text }}>
              {comp.value}
            </div>
            {comp.trend && (
              <div style={{ 
                fontSize: '0.9em', 
                color: comp.trend.startsWith('+') ? colors.success : colors.error,
                fontWeight: '500'
              }}>
                {comp.trend}
              </div>
            )}
          </div>
        )
      
      case 'panel':
        const panelStyle = {
          ...baseStyle,
          width: comp.width || '100%',
          border: `1px solid ${colors.border}`,
          borderRadius: '6px',
          padding: '16px',
          backgroundColor: colors.surfaceElevated
        }
        return (
          <div key={key} style={panelStyle}>
            {comp.components?.map((c, i) => renderComponent(c, i))}
          </div>
        )
      
      default:
        return (
          <div key={key} style={baseStyle}>
            <pre style={{ 
            fontSize: '0.85em', 
            backgroundColor: colors.surface, 
            padding: '12px', 
            borderRadius: '6px', 
            overflow: 'auto',
            border: `1px solid ${colors.border}`,
            color: colors.textSecondary,
            fontFamily: '"SF Mono", Monaco, "Courier New", monospace'
          }}>
              {JSON.stringify(comp, null, 2)}
            </pre>
          </div>
        )
    }
  }

  return (
    <div style={{ 
      border: `1px solid ${colors.border}`, 
      borderRadius: '10px', 
      padding: '20px', 
      backgroundColor: colors.cardBg 
    }}>
      <div style={{ 
        marginBottom: '16px', 
        fontWeight: '700', 
        color: colors.textSecondary,
        fontSize: '0.85em',
        textTransform: 'uppercase',
        letterSpacing: '1.5px',
        fontFamily: nexverseFont
      }}>
        Screen: {content.screen}
      </div>
      <div style={{ 
        display: content.layout === 'grid' ? 'grid' : 'flex',
        flexDirection: content.layout === 'vertical' ? 'column' : 'row',
        gridTemplateColumns: content.layout === 'grid' && content.columns ? `repeat(${content.columns}, 1fr)` : undefined,
        gap: '16px'
      }}>
        {content.components?.map((comp, index) => renderComponent(comp, index))}
      </div>
    </div>
  )
}

function ArtifactRenderer({ artifact, onSelect, isActive, setImageRef, annotateEnabled }) {
  switch (artifact.type) {
    case 'ui_spec':
      return <UISpecRenderer artifact={artifact} />
    
    case 'image':
      // Images are displayed in mobile-sized containers (portrait 9:16)
      return (
        <div style={{ 
          border: `1px solid ${colors.border}`, 
          borderRadius: '12px', 
          padding: '0',
          backgroundColor: colors.cardBg,
          overflow: 'hidden',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          display: 'flex',
          flexDirection: 'column'
        }}>
          {artifact.screen && (
            <div style={{
              padding: '12px 16px',
              borderBottom: `1px solid ${colors.border}`,
              backgroundColor: colors.surfaceElevated,
              fontSize: '0.85em',
              color: colors.textSecondary,
              fontWeight: '600',
              textTransform: 'uppercase',
              letterSpacing: '1px',
              fontFamily: nexverseFont
            }}>
              {artifact.screen}
            </div>
          )}
          {/* Mobile frame container */}
          <div style={{ 
            padding: '20px',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: colors.surface
          }}>
            {/* Mobile phone frame */}
            <div
              onClick={onSelect}
              style={{
              width: '375px', // Standard iPhone width
              maxWidth: '100%',
              aspectRatio: '9 / 16', // Portrait mobile aspect ratio
              backgroundColor: '#000',
              borderRadius: '24px',
              padding: '8px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              position: 'relative',
              outline: isActive ? `2px solid ${colors.accentBlue}` : 'none',
              outlineOffset: '2px'
            }}>
              {/* Screen bezel */}
              <div style={{
                width: '100%',
                height: '100%',
                borderRadius: '16px',
                overflow: 'hidden',
                backgroundColor: colors.background,
                position: 'relative'
              }}>
                <AnnotatableImage
                  ref={setImageRef}
                  imageUrl={artifact.content.url || artifact.content}
                  annotateEnabled={annotateEnabled}
                />
              </div>
              {/* Home indicator (iPhone style) */}
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
      )
    
    case 'json':
      return (
        <div style={{ 
          border: `1px solid ${colors.border}`, 
          borderRadius: '10px', 
          padding: '16px', 
          backgroundColor: colors.cardBg 
        }}>
          <pre style={{ 
            margin: 0, 
            fontSize: '0.85em', 
            overflow: 'auto',
            backgroundColor: colors.surface,
            padding: '16px',
            borderRadius: '6px',
            border: `1px solid ${colors.border}`,
            color: colors.textSecondary,
            fontFamily: '"SF Mono", Monaco, "Courier New", monospace'
          }}>
            {JSON.stringify(artifact.content, null, 2)}
          </pre>
        </div>
      )
    
    case 'code':
      return (
        <div style={{ 
          border: `1px solid ${colors.border}`, 
          borderRadius: '10px', 
          padding: '16px', 
          backgroundColor: colors.background 
        }}>
          <pre style={{ 
            margin: 0, 
            fontSize: '0.85em', 
            overflow: 'auto',
            color: colors.textSecondary,
            fontFamily: '"SF Mono", Monaco, "Courier New", monospace',
            lineHeight: '1.5'
          }}>
            <code>{typeof artifact.content === 'string' ? artifact.content : JSON.stringify(artifact.content, null, 2)}</code>
          </pre>
        </div>
      )
    
    case 'text':
      return (
        <div style={{ 
          border: `1px solid ${colors.border}`, 
          borderRadius: '10px', 
          padding: '20px', 
          backgroundColor: colors.cardBg 
        }}>
          <div style={{ 
            whiteSpace: 'pre-wrap', 
            lineHeight: '1.7',
            color: colors.text,
            fontSize: '14px',
            fontFamily: nexverseFont
          }}>
            {typeof artifact.content === 'string' ? artifact.content : artifact.content?.text || JSON.stringify(artifact.content, null, 2)}
          </div>
        </div>
      )
    
    default:
      return (
        <div style={{ 
          border: `1px solid ${colors.border}`, 
          borderRadius: '10px', 
          padding: '16px', 
          backgroundColor: colors.cardBg 
        }}>
          <div style={{ 
            color: colors.textMuted, 
            marginBottom: '12px',
            fontSize: '0.9em'
          }}>
            Unsupported artifact type: {artifact.type}
          </div>
          <pre style={{ 
            fontSize: '0.85em', 
            overflow: 'auto',
            backgroundColor: colors.surface,
            padding: '12px',
            borderRadius: '6px',
            border: `1px solid ${colors.border}`,
            color: colors.textSecondary
          }}>
            {JSON.stringify(artifact.content, null, 2)}
          </pre>
        </div>
      )
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
  const [artifacts, setArtifacts] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [regeneratingId, setRegeneratingId] = useState(null)
  const [activeImageId, setActiveImageId] = useState(null)
  const [annotateOn, setAnnotateOn] = useState(false)
  const messagesEndRef = useRef(null)
  const chatContainerRef = useRef(null)
  const imageRefs = useRef({})

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  useEffect(() => {
    const firstImage = artifacts.find(a => a.type === 'image')
    if (!firstImage) {
      setActiveImageId(null)
      setAnnotateOn(false)
      return
    }
    const exists = artifacts.some(a => a.id === activeImageId)
    if (!exists) {
      setActiveImageId(firstImage.id)
    }
    setAnnotateOn(false)
  }, [artifacts, activeImageId])

  async function sendMessage() {
    if (!input.trim() || loading) return

    const userMessage = input.trim()
    setInput('')
    setLoading(true)

    // Add user message immediately
    setMessages(m => [...m, { role: 'user', content: userMessage }])

    try {
      const res = await fetch('http://localhost:3001/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: userMessage,
          sessionId: 'default' // Maintain session for Warp to store UI specs
        })
      })

      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`)
      }

      const data = await res.json()

      // Add assistant message
      setMessages(m => [...m, { role: 'assistant', content: data.chat || 'Response received' }])
      
      // Backend now returns full session artifacts
      if (data.artifacts && data.artifacts.length > 0) {
        setArtifacts(data.artifacts)
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

  function handleKeyPress(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  function clearChat() {
    setMessages([])
    setArtifacts([])
    fetch('http://localhost:3001/api/chat/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'default' })
    }).catch(console.error)
  }

  async function handleRegenerate(artifactId, imageSource, maskDataURL, prompt) {
    if (!imageSource || !maskDataURL) {
      alert('Missing image or mask data. Please annotate the image first.')
      return false
    }

    setRegeneratingId(artifactId)

    try {
      if (prompt?.trim()) {
        setMessages(m => [...m, { role: 'user', content: prompt.trim() }])
      }
      const res = await fetch('http://localhost:3001/api/image/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageSource,
          maskDataURL,
          prompt,
          artifactId,
          sessionId: 'default'
        })
      })

      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`)
      }

      const data = await res.json()

      if (data?.artifacts?.length) {
        setArtifacts(data.artifacts)
      } else if (data?.artifact) {
        setArtifacts(prev => prev.map(artifact => (
          artifact.id === artifactId
            ? { ...artifact, content: { url: data.artifact.content?.url || data.imageUrl } }
            : artifact
        )))
      }

      setMessages(m => [...m, {
        role: 'assistant',
        content: 'Updated the image based on your annotations.'
      }])
      return true
    } catch (error) {
      console.error('Error regenerating image:', error)
      alert('Failed to regenerate image. Please try again.')
      return false
    } finally {
      setRegeneratingId(null)
    }
  }

  const getActiveImageRef = () => (
    activeImageId ? imageRefs.current[activeImageId] : null
  )

  const getActiveImageArtifact = () => (
    artifacts.find(a => a.id === activeImageId)
  )

  function handleToggleAnnotate() {
    if (!activeImageId) return
    setAnnotateOn(prev => !prev)
  }

  function handleClearAnnotations() {
    const ref = getActiveImageRef()
    ref?.clearAnnotations?.()
  }

  function handleExportMask() {
    const ref = getActiveImageRef()
    const maskDataURL = ref?.exportMask?.()
    if (!maskDataURL) {
      alert('No mask to export. Please annotate the image first.')
      return
    }
    const link = document.createElement('a')
    link.download = 'mask.png'
    link.href = maskDataURL
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  async function handleRegenerateFromNavbar() {
    const ref = getActiveImageRef()
    const activeArtifact = getActiveImageArtifact()
    if (!ref || !activeArtifact) return
    const maskDataURL = ref.exportMask?.()
    if (!maskDataURL) {
      alert('Please annotate the image first.')
      return
    }
    const prompt = ref.getPrompt?.() || 'Edit the masked area to improve the design'
    const imageSource = activeArtifact.content?.url || activeArtifact.content
    const success = await handleRegenerate(activeArtifact.id, imageSource, maskDataURL, prompt)
    if (success) {
      ref.clearAnnotations?.()
    }
  }

  const hasActiveImage = !!activeImageId
  const activeHasAnnotations = getActiveImageRef()?.hasAnnotations?.() || false

  return (
    <div style={{ 
      display: 'flex', 
      height: '100vh', 
      fontFamily: nexverseFont,
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
          {messages.map((m, i) => (
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
          ))}
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

      {/* Right Panel - Artifacts */}
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
              Output
            </h3>
            {artifacts.length > 0 && (
              <div style={{ 
                fontSize: '0.75em', 
                color: colors.textMuted, 
                marginTop: '4px',
                fontFamily: nexverseFont,
                letterSpacing: '0.5px'
              }}>
                {artifacts.length} artifact{artifacts.length !== 1 ? 's' : ''} generated
              </div>
            )}
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            justifyContent: 'flex-end'
          }}>
            <div style={{
              fontSize: '0.7em',
              color: colors.textMuted,
              fontWeight: '700',
              letterSpacing: '1.2px',
              textTransform: 'uppercase',
              fontFamily: nexverseFont,
              marginRight: '6px'
            }}>
              Annotate
            </div>
            <button
              onClick={handleToggleAnnotate}
              disabled={!hasActiveImage}
              style={{
                padding: '8px 12px',
                border: `1px solid ${colors.border}`,
                borderRadius: '8px',
                backgroundColor: annotateOn ? colors.accentBlue : colors.surfaceElevated,
                color: annotateOn ? '#fff' : colors.text,
                cursor: hasActiveImage ? 'pointer' : 'not-allowed',
                fontSize: '12px',
                fontWeight: '600',
                fontFamily: nexverseFont
              }}
            >
              {annotateOn ? 'Annotating' : 'Annotate'}
            </button>
            <button
              onClick={handleRegenerateFromNavbar}
              disabled={!hasActiveImage || !activeHasAnnotations || regeneratingId === activeImageId}
              style={{
                padding: '8px 12px',
                border: `1px solid ${colors.border}`,
                borderRadius: '8px',
                backgroundColor: colors.accentBlue,
                color: '#fff',
                cursor: hasActiveImage && activeHasAnnotations ? 'pointer' : 'not-allowed',
                fontSize: '12px',
                fontWeight: '600',
                fontFamily: nexverseFont,
                opacity: hasActiveImage && activeHasAnnotations ? 1 : 0.6
              }}
            >
              Regenerate
            </button>
            <button
              onClick={handleExportMask}
              disabled={!hasActiveImage || !activeHasAnnotations}
              style={{
                padding: '8px 12px',
                border: `1px solid ${colors.border}`,
                borderRadius: '8px',
                backgroundColor: colors.surfaceElevated,
                color: colors.text,
                cursor: hasActiveImage && activeHasAnnotations ? 'pointer' : 'not-allowed',
                fontSize: '12px',
                fontWeight: '600',
                fontFamily: nexverseFont,
                opacity: hasActiveImage && activeHasAnnotations ? 1 : 0.6
              }}
            >
              Export Mask
            </button>
            <button
              onClick={handleClearAnnotations}
              disabled={!hasActiveImage || !activeHasAnnotations}
              style={{
                padding: '8px 12px',
                border: `1px solid ${colors.border}`,
                borderRadius: '8px',
                backgroundColor: colors.surfaceElevated,
                color: colors.text,
                cursor: hasActiveImage && activeHasAnnotations ? 'pointer' : 'not-allowed',
                fontSize: '12px',
                fontWeight: '600',
                fontFamily: nexverseFont,
                opacity: hasActiveImage && activeHasAnnotations ? 1 : 0.6
              }}
            >
              Clear
            </button>
          </div>
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
          {artifacts.length === 0 ? (
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {artifacts.map(a => (
                <div key={a.id}>
                  <h4 style={{ 
                    margin: '0 0 16px 0', 
                    fontSize: '18px', 
                    fontWeight: '700',
                    color: colors.text,
                    letterSpacing: '0.5px',
                    fontFamily: nexverseFont,
                    textTransform: 'uppercase'
                  }}>
                    {a.title}
                  </h4>
                  <ArtifactRenderer
                    artifact={a}
                    isActive={a.id === activeImageId}
                    onSelect={() => setActiveImageId(a.id)}
                    setImageRef={(node) => { imageRefs.current[a.id] = node }}
                    annotateEnabled={a.id === activeImageId ? annotateOn : false}
                  />
                  {regeneratingId === a.id && (
                    <div style={{
                      marginTop: '12px',
                      padding: '12px',
                      borderRadius: '6px',
                      backgroundColor: colors.surfaceElevated,
                      border: `1px solid ${colors.border}`,
                      color: colors.textSecondary,
                      fontSize: '14px',
                      fontFamily: nexverseFont,
                      textAlign: 'center'
                    }}>
                      Regenerating image...
                    </div>
                  )}
          </div>
        ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
