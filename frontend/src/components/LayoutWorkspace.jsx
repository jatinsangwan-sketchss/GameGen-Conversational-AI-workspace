import { useMemo, useRef, useState, useEffect } from 'react'
import AssetShelf from './AssetShelf'
import LayoutCanvas from './LayoutCanvas'
import { saveLayout } from '../api/layoutApi'
import { editAsset as editAssetApi } from '../api/editAssetApi'

const layoutColors = {
  panel: '#111111',
  border: '#2a2a2a',
  textMuted: '#a0a0a0'
}

function deriveGameNameFromAssets(assetsByScreen, screenName) {
  const assets = assetsByScreen?.[screenName] || []
  const first = assets.find((asset) => asset?.path)
  if (!first?.path) return 'game_ui'
  const match = first.path.match(/^assets\/([^/]+)\//)
  return match?.[1] || 'game_ui'
}

export default function LayoutWorkspace({
  screens = [],
  assets = {},
  layoutByScreen,
  setLayoutByScreen,
  onSaved,
  designContext,
  onAnnotationLog
}) {
  const containerRef = useRef(null)
  const [canvasSize, setCanvasSize] = useState({ width: 375, height: 666 })
  const [selectedId, setSelectedId] = useState(null)
  const [draggedAsset, setDraggedAsset] = useState(null)
  const [annotateMode, setAnnotateMode] = useState(false)
  const [selectedAsset, setSelectedAsset] = useState(null)
  const [annotationText, setAnnotationText] = useState('')
  const [isEditingAsset, setIsEditingAsset] = useState(false)
  const [annotateNotice, setAnnotateNotice] = useState('')
  const [overlayPosition, setOverlayPosition] = useState({ left: 0, top: 0 })
  const canvasFrameRef = useRef(null)
  const [selectedScreenName, setSelectedScreenName] = useState(
    screens?.[0]?.name || ''
  )

  const hasSelection = Boolean(selectedId)

  useEffect(() => {
    if (!selectedScreenName && screens.length) {
      setSelectedScreenName(screens[0].name)
    }
  }, [screens, selectedScreenName])

  useEffect(() => {
    if (!annotateMode) {
      setSelectedAsset(null)
      setAnnotationText('')
      setAnnotateNotice('')
    }
  }, [annotateMode])

  useEffect(() => {
    if (!selectedScreenName) {
      setSelectedId(null)
    }
  }, [selectedScreenName])


  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width
      const height = width * (16 / 9)
      setCanvasSize({ width, height })
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  const screenAssets = useMemo(() => {
    return selectedScreenName ? assets[selectedScreenName] || [] : []
  }, [assets, selectedScreenName])

  const elements = layoutByScreen?.[selectedScreenName]?.elements || []
  const selectedElement = selectedAsset
    ? elements.find((el) => el.id === selectedAsset.elementId)
    : null

  useEffect(() => {
    if (!selectedElement || !canvasFrameRef.current || !containerRef.current) return
    const frameRect = canvasFrameRef.current.getBoundingClientRect()
    const parentRect = containerRef.current.getBoundingClientRect()

    const baseLeft = frameRect.left - parentRect.left + selectedElement.x + 16
    const baseTop = frameRect.top - parentRect.top + selectedElement.y + 16

    const popupWidth = 260
    const popupHeight = 160
    const maxLeft = parentRect.width - popupWidth - 12
    const maxTop = parentRect.height - popupHeight - 12

    setOverlayPosition({
      left: Math.min(Math.max(baseLeft, 12), Math.max(maxLeft, 12)),
      top: Math.min(Math.max(baseTop, 12), Math.max(maxTop, 12))
    })
  }, [selectedElement, canvasSize.width, canvasSize.height])

  function handleDragStart(asset, event) {
    if (annotateMode || isEditingAsset) return
    setDraggedAsset(asset)
    if (event?.dataTransfer) {
      event.dataTransfer.setData('application/json', JSON.stringify(asset))
    }
  }

  function handleDrop(event) {
    if (annotateMode || isEditingAsset) return
    event.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return

    let asset = draggedAsset
    const data = event.dataTransfer?.getData('application/json')
    if (!asset && data) {
      try {
        asset = JSON.parse(data)
      } catch {
        asset = null
      }
    }
    if (!asset) return

    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const defaultWidth = canvasSize.width * 0.3
    const defaultHeight = canvasSize.height * 0.12
    const maxZ = elements.reduce((max, el) => Math.max(max, el.zIndex || 0), 0)

    const nextElement = {
      id: `${asset.id}_${Date.now()}`,
      assetId: asset.id,
      assetPath: asset.path,
      x,
      y,
      width: defaultWidth,
      height: defaultHeight,
      rotation: 0,
      zIndex: maxZ + 1
    }

    setLayoutByScreen?.((prev) => ({
      ...prev,
      [selectedScreenName]: {
        screenName: selectedScreenName,
        elements: [...elements, nextElement]
      }
    }))
    setSelectedId(nextElement.id)
    setDraggedAsset(null)
  }

  function handleElementChange(updated) {
    if (annotateMode || isEditingAsset) return
    const next = elements.map((el) => (el.id === updated.id ? updated : el))
    setLayoutByScreen?.((prev) => ({
      ...prev,
      [selectedScreenName]: {
        screenName: selectedScreenName,
        elements: next
      }
    }))
  }

  function handleRemoveSelected() {
    if (annotateMode || isEditingAsset) return
    if (!selectedId) return
    const next = elements.filter((el) => el.id !== selectedId)
    setLayoutByScreen?.((prev) => ({
      ...prev,
      [selectedScreenName]: {
        screenName: selectedScreenName,
        elements: next
      }
    }))
    setSelectedId(null)
  }

  useEffect(() => {
    if (!hasSelection) return
    function handleKeyDown(event) {
      if (annotateMode || isEditingAsset) return
      const target = event.target
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) {
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        handleRemoveSelected()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hasSelection, annotateMode, isEditingAsset, selectedId, elements])


  async function handleSave() {
    if (!selectedScreenName) return
    const gameName = deriveGameNameFromAssets(assets, selectedScreenName)
    const payload = {
      gameName,
      screenName: selectedScreenName,
      elements: elements.map((el) => ({
        asset: el.assetId,
        xPercent: el.x / canvasSize.width,
        yPercent: el.y / canvasSize.height,
        widthPercent: el.width / canvasSize.width,
        heightPercent: el.height / canvasSize.height,
        rotation: el.rotation || 0,
        zIndex: el.zIndex || 0
      }))
    }
    await saveLayout(payload)
    onSaved?.('Screen layout saved')
  }

  function handleSelectAsset(element) {
    if (!annotateMode) return
    if (isEditingAsset) return
    if (!element) {
      setSelectedAsset(null)
      return
    }
    if (selectedAsset && selectedAsset.elementId !== element.id) {
      setAnnotateNotice('Finish the current annotation before selecting another asset.')
      setTimeout(() => setAnnotateNotice(''), 2000)
      return
    }
    const assetInfo = screenAssets.find((asset) => asset.id === element.assetId)
    setSelectedAsset({
      elementId: element.id,
      assetId: element.assetId,
      assetPath: element.assetPath,
      fileName: assetInfo?.fileName || null
    })
  }

  async function handleSubmitAnnotation() {
    if (!selectedAsset || !annotationText.trim()) return
    setIsEditingAsset(true)
    try {
      onAnnotationLog?.({
        assetName: selectedAsset.fileName || selectedAsset.assetId,
        instruction: annotationText.trim()
      })
      const gameName = deriveGameNameFromAssets(assets, selectedScreenName)
      await editAssetApi({
        assetPath: selectedAsset.assetPath,
        instruction: annotationText.trim(),
        designContext: designContext || 'unknown',
        gameName,
        screenName: selectedScreenName
      })

      const updatedElements = elements.map((el) => {
        if (el.id !== selectedAsset.elementId) return el
        return {
          ...el,
          cacheKey: Date.now()
        }
      })
      setLayoutByScreen?.((prev) => ({
        ...prev,
        [selectedScreenName]: {
          screenName: selectedScreenName,
          elements: updatedElements
        }
      }))
      setSelectedAsset(null)
      setAnnotationText('')
      setAnnotateMode(false)
      onSaved?.('Asset updated')
    } finally {
      setIsEditingAsset(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: '20px', height: '100%' }}>
      <div style={{
        width: '35%',
        border: `1px solid ${layoutColors.border}`,
        borderRadius: '12px',
        padding: '16px',
        background: layoutColors.panel,
        overflowY: 'auto'
      }}>
        <div style={{ marginBottom: '12px', color: '#fff', fontSize: '14px' }}>
          Assets
        </div>
        <div style={{ marginBottom: '12px' }}>
          <select
            value={selectedScreenName}
            onChange={(e) => setSelectedScreenName(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: '8px',
              border: `1px solid ${layoutColors.border}`,
              background: '#1a1a1a',
              color: '#fff'
            }}
          >
            {screens.map((screen) => (
              <option key={screen.name} value={screen.name}>
                {screen.name}
              </option>
            ))}
          </select>
        </div>
        <AssetShelf
          assets={screenAssets}
          onDragStart={handleDragStart}
          disabled={annotateMode || isEditingAsset}
        />
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ color: layoutColors.textMuted, fontSize: '12px' }}>
            {annotateMode
              ? 'Annotate mode: click an asset to edit its visual style'
              : 'Drag assets into the canvas'}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setAnnotateMode((prev) => !prev)}
              disabled={isEditingAsset}
              style={{
                padding: '10px 16px',
                borderRadius: '8px',
                border: `1px solid ${layoutColors.border}`,
                background: annotateMode ? '#1f2937' : '#0f172a',
                color: '#fff',
                fontWeight: 600,
                cursor: isEditingAsset ? 'not-allowed' : 'pointer'
              }}
            >
              Annotate
            </button>
            <button
              onClick={handleSave}
              disabled={annotateMode || isEditingAsset}
              style={{
                padding: '10px 16px',
                borderRadius: '8px',
                border: 'none',
                background: annotateMode || isEditingAsset ? '#475569' : '#3b82f6',
                color: '#fff',
                fontWeight: 600,
                cursor: annotateMode || isEditingAsset ? 'not-allowed' : 'pointer'
              }}
            >
              Save Screen
            </button>
            <button
              onClick={handleRemoveSelected}
              disabled={!hasSelection || annotateMode || isEditingAsset}
              style={{
                padding: '10px 16px',
                borderRadius: '8px',
                border: `1px solid ${layoutColors.border}`,
                background: !hasSelection || annotateMode || isEditingAsset ? '#1f2937' : '#111827',
                color: !hasSelection || annotateMode || isEditingAsset ? '#64748b' : '#f8fafc',
                fontWeight: 600,
                cursor: !hasSelection || annotateMode || isEditingAsset ? 'not-allowed' : 'pointer'
              }}
            >
              Remove
            </button>
          </div>
        </div>
        {annotateNotice && (
          <div style={{ color: '#fbbf24', fontSize: '12px' }}>
            {annotateNotice}
          </div>
        )}

        <div
          ref={containerRef}
          onDrop={handleDrop}
          onDragOver={(event) => event.preventDefault()}
          style={{
            flex: 1,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-start',
            position: 'relative'
          }}
        >
          <div style={{
            width: '100%',
            maxWidth: '420px',
            aspectRatio: '9 / 16',
            borderRadius: '24px',
            overflow: 'hidden',
            border: `1px solid ${layoutColors.border}`,
            background: '#0f0f0f',
            position: 'relative'
          }}
          ref={canvasFrameRef}
          >
            <LayoutCanvas
              width={canvasSize.width}
              height={canvasSize.height}
              elements={elements}
              selectedId={annotateMode ? selectedAsset?.elementId : selectedId}
              annotateMode={annotateMode}
              isEditingAsset={isEditingAsset}
              onSelect={setSelectedId}
              onSelectAsset={handleSelectAsset}
              onChange={handleElementChange}
            />
          </div>
          {annotateMode && selectedElement && !isEditingAsset && (
            <div style={{
              position: 'absolute',
              left: overlayPosition.left,
              top: overlayPosition.top,
              width: '260px',
              background: 'linear-gradient(180deg, rgba(20,27,44,0.98) 0%, rgba(12,18,32,0.98) 100%)',
              border: '1px solid rgba(59,130,246,0.35)',
              borderRadius: '12px',
              padding: '12px',
              color: '#e5e7eb',
              boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
              zIndex: 20
            }}>
              <div style={{
                fontSize: '12px',
                marginBottom: '8px',
                color: '#cbd5f5',
                letterSpacing: '0.3px'
              }}>
                Edit {selectedAsset?.fileName || selectedAsset?.assetId}
              </div>
              <textarea
                value={annotationText}
                onChange={(e) => setAnnotationText(e.target.value)}
                rows={3}
                style={{
                  width: '100%',
                  resize: 'none',
                  background: '#0b1220',
                  color: '#e5e7eb',
                  border: '1px solid rgba(148,163,184,0.25)',
                  borderRadius: '8px',
                  padding: '8px',
                  outline: 'none'
                }}
              />
              <button
                onClick={handleSubmitAnnotation}
                disabled={!annotationText.trim()}
                style={{
                  marginTop: '10px',
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  border: 'none',
                  background: annotationText.trim() ? '#3b82f6' : '#475569',
                  color: '#fff',
                  fontWeight: 600,
                  cursor: !annotationText.trim() ? 'not-allowed' : 'pointer'
                }}
              >
                Apply Edit
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
