import { useEffect, useMemo, useRef, useState } from 'react'
import { Stage, Layer, Image as KonvaImage, Transformer } from 'react-konva'
import { buildAssetUrl } from '../utils/assetUtils'

function CanvasAsset({ element, isSelected, onSelect, onChange }) {
  const shapeRef = useRef(null)
  const [image, setImage] = useState(null)

  useEffect(() => {
    let isMounted = true
    const img = new window.Image()
    img.src = buildAssetUrl(element.assetPath)
    img.onload = () => {
      if (isMounted) setImage(img)
    }
    return () => {
      isMounted = false
    }
  }, [element.assetPath])

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
      draggable
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(event) => {
        onChange({
          ...element,
          x: event.target.x(),
          y: event.target.y()
        })
      }}
      onTransformEnd={(event) => {
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
    />
  )
}

export default function LayoutCanvas({
  width,
  height,
  elements = [],
  selectedId,
  onSelect,
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
          onSelect(null)
        }
      }}
      onTouchStart={(event) => {
        if (event.target === event.target.getStage()) {
          onSelect(null)
        }
      }}
    >
      <Layer>
        {orderedElements.map((element) => (
          <CanvasAsset
            key={element.id}
            element={element}
            isSelected={element.id === selectedId}
            onSelect={() => onSelect(element.id)}
            onChange={(next) => onChange(next)}
          />
        ))}
        <Transformer
          ref={transformerRef}
          rotateEnabled
          keepRatio={false}
          enabledAnchors={[
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
