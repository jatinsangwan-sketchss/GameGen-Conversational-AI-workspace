import { useMemo, useRef, useState, useEffect } from 'react'
import AssetShelf from './AssetShelf'
import LayoutCanvas from './LayoutCanvas'
import { saveLayout } from '../api/layoutApi'

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
  onSaved
}) {
  const containerRef = useRef(null)
  const [canvasSize, setCanvasSize] = useState({ width: 375, height: 666 })
  const [selectedId, setSelectedId] = useState(null)
  const [draggedAsset, setDraggedAsset] = useState(null)
  const [selectedScreenName, setSelectedScreenName] = useState(
    screens?.[0]?.name || ''
  )

  useEffect(() => {
    if (!selectedScreenName && screens.length) {
      setSelectedScreenName(screens[0].name)
    }
  }, [screens, selectedScreenName])

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

  function handleDragStart(asset, event) {
    setDraggedAsset(asset)
    if (event?.dataTransfer) {
      event.dataTransfer.setData('application/json', JSON.stringify(asset))
    }
  }

  function handleDrop(event) {
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
    const next = elements.map((el) => (el.id === updated.id ? updated : el))
    setLayoutByScreen?.((prev) => ({
      ...prev,
      [selectedScreenName]: {
        screenName: selectedScreenName,
        elements: next
      }
    }))
  }

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
        <AssetShelf assets={screenAssets} onDragStart={handleDragStart} />
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ color: layoutColors.textMuted, fontSize: '12px' }}>
            Drag assets into the canvas and resize as needed
          </div>
          <button
            onClick={handleSave}
            style={{
              padding: '10px 16px',
              borderRadius: '8px',
              border: 'none',
              background: '#3b82f6',
              color: '#fff',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            Save Screen
          </button>
        </div>

        <div
          ref={containerRef}
          onDrop={handleDrop}
          onDragOver={(event) => event.preventDefault()}
          style={{
            flex: 1,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-start'
          }}
        >
          <div style={{
            width: '100%',
            maxWidth: '420px',
            aspectRatio: '9 / 16',
            borderRadius: '24px',
            overflow: 'hidden',
            border: `1px solid ${layoutColors.border}`,
            background: '#0f0f0f'
          }}>
            <LayoutCanvas
              width={canvasSize.width}
              height={canvasSize.height}
              elements={elements}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onChange={handleElementChange}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
