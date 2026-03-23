import { useEffect, useMemo, useRef, useState } from 'react'
import { Stage, Layer, Image as KonvaImage, Transformer, Rect, Text } from 'react-konva'
import { buildAssetUrl } from '../utils/assetUtils'

function buildImageUrl(assetPath, cacheKey) {
  const base = buildAssetUrl(assetPath)
  if (!cacheKey) return base
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}v=${cacheKey}`
}

function CanvasAsset({ element, isSelected, annotateMode, isEditingAsset, onSelect, onChange }) {
  const shapeRef = useRef(null)
  const [image, setImage] = useState(null)

  useEffect(() => {
    let isMounted = true
    const img = new window.Image()
    img.src = buildImageUrl(element.assetPath, element.cacheKey)
    img.onload = () => {
      if (isMounted) setImage(img)
    }
    return () => {
      isMounted = false
    }
  }, [element.assetPath, element.cacheKey])

  return (
    <KonvaImage
      ref={shapeRef}
      id={element.id}
      image={image}
      x={element.x}
      y={element.y}
      width={element.width}
      height={element.height}
      rotation={element.rotation || 0}
      draggable={!annotateMode && !isEditingAsset}
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(event) => {
        if (annotateMode || isEditingAsset) return
        onChange({
          ...element,
          x: event.target.x(),
          y: event.target.y()
        })
      }}
      onTransformEnd={(event) => {
        if (annotateMode || isEditingAsset) return
        const node = event.target
        const scaleX = node.scaleX()
        const scaleY = node.scaleY()

        node.scaleX(1)
        node.scaleY(1)

        onChange({
          ...element,
          x: node.x(),
          y: node.y(),
          rotation: node.rotation(),
          width: Math.max(20, node.width() * scaleX),
          height: Math.max(20, node.height() * scaleY)
        })
      }}
      shadowEnabled={isSelected}
      shadowBlur={isSelected ? 8 : 0}
      shadowColor={isSelected ? 'rgba(0,0,0,0.35)' : 'transparent'}
      shadowOffsetX={isSelected ? 2 : 0}
      shadowOffsetY={isSelected ? 2 : 0}
      stroke={annotateMode && isSelected ? '#60a5fa' : undefined}
      strokeWidth={annotateMode && isSelected ? 2 : 0}
    />
  )
}

export default function LayoutCanvas({
  width,
  height,
  elements = [],
  selectedId,
  annotateMode = false,
  isEditingAsset = false,
  onSelect,
  onSelectAsset,
  onChange
}) {
  const stageRef = useRef(null)
  const transformerRef = useRef(null)

  const orderedElements = useMemo(() => {
    return [...elements].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0))
  }, [elements])

  useEffect(() => {
    if (!transformerRef.current || !stageRef.current) return
    const stage = stageRef.current.getStage()
    const selectedNode = stage.findOne((node) => node?.attrs?.id === selectedId)
    if (selectedNode) {
      transformerRef.current.nodes([selectedNode])
      transformerRef.current.getLayer()?.batchDraw()
    } else {
      transformerRef.current.nodes([])
      transformerRef.current.getLayer()?.batchDraw()
    }
  }, [selectedId, elements])

  return (
    <Stage
      ref={stageRef}
      width={width}
      height={height}
      style={{ background: '#111', borderRadius: '24px' }}
      onMouseDown={(event) => {
        if (event.target === event.target.getStage()) {
          if (annotateMode) {
            onSelectAsset?.(null)
          } else {
            onSelect(null)
          }
        }
      }}
      onTouchStart={(event) => {
        if (event.target === event.target.getStage()) {
          if (annotateMode) {
            onSelectAsset?.(null)
          } else {
            onSelect(null)
          }
        }
      }}
    >
      <Layer>
        {orderedElements.map((element) => (
          <CanvasAsset
            key={element.id}
            element={element}
            isSelected={element.id === selectedId}
            annotateMode={annotateMode}
            isEditingAsset={isEditingAsset}
            onSelect={() => {
              if (annotateMode) {
                onSelectAsset?.(element)
              } else {
                onSelect(element.id)
              }
            }}
            onChange={(next) => onChange(next)}
          />
        ))}
        {annotateMode && isEditingAsset && selectedId && (() => {
          const selected = elements.find((el) => el.id === selectedId)
          if (!selected) return null
          return (
            <>
              <Rect
                x={selected.x}
                y={selected.y}
                width={selected.width}
                height={selected.height}
                fill="rgba(0,0,0,0.45)"
                cornerRadius={6}
              />
              <Text
                x={selected.x}
                y={selected.y + selected.height / 2 - 8}
                width={selected.width}
                text="Editing..."
                fontSize={12}
                fill="#ffffff"
                align="center"
              />
            </>
          )
        })()}
        <Transformer
          ref={transformerRef}
          visible={!annotateMode}
          rotateEnabled={!annotateMode}
          keepRatio={false}
          enabledAnchors={annotateMode ? [] : [
            'top-left',
            'top-center',
            'top-right',
            'middle-left',
            'middle-right',
            'bottom-left',
            'bottom-center',
            'bottom-right'
          ]}
          padding={6}
          boundBoxFunc={(oldBox, newBox) => {
            if (newBox.width < 20 || newBox.height < 20) {
              return oldBox
            }
            return newBox
          }}
        />
      </Layer>
    </Stage>
  )
}
