import { useState, useRef, useEffect, useImperativeHandle, forwardRef } from 'react'
import { Stage, Layer, Image as KonvaImage, Line } from 'react-konva'
import Konva from 'konva'

const colors = {
  background: '#0a0a0a',
  surface: '#1a1a1a',
  surfaceElevated: '#252525',
  border: '#333333',
  text: '#e0e0e0',
  textSecondary: '#a0a0a0',
  accentBlue: '#3b82f6',
  accentBlueHover: '#2563eb',
  error: '#ef4444'
}

const AnnotatableImage = forwardRef(function AnnotatableImage({ imageUrl, annotateEnabled }, ref) {
  const [image, setImage] = useState(null)
  const [isAnnotating, setIsAnnotating] = useState(false)
  const [lines, setLines] = useState([])
  const [isDrawing, setIsDrawing] = useState(false)
  const [regeneratePrompt, setRegeneratePrompt] = useState('')
  const [promptAnchor, setPromptAnchor] = useState({ x: 12, y: 12 })
  const [showPrompt, setShowPrompt] = useState(false)
  const stageRef = useRef(null)
  const containerRef = useRef(null)
  const [stageSize, setStageSize] = useState({ width: 375, height: 667 })
  const [imageSize, setImageSize] = useState({ width: 375, height: 667, x: 0, y: 0 })

  useEffect(() => {
    if (typeof annotateEnabled === 'boolean') {
      setIsAnnotating(annotateEnabled)
    }
  }, [annotateEnabled])

  // Load image
  useEffect(() => {
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      setImage(img)
    }
    img.onerror = () => {
      console.error('Failed to load image')
    }
    img.src = imageUrl
  }, [imageUrl])

  // Update stage size when image loads or container resizes
  useEffect(() => {
    if (!image || !containerRef.current) return

    const updateSize = () => {
      const container = containerRef.current
      if (!container) return

      // Get the actual displayed size of the image container
      const containerWidth = container.offsetWidth || 375
      const containerHeight = container.offsetHeight || 667

      setStageSize({
        width: containerWidth,
        height: containerHeight
      })

      // Calculate image dimensions to fill container (object-fit: cover behavior)
      const imageAspect = image.width / image.height
      const containerAspect = containerWidth / containerHeight

      let imgWidth, imgHeight, imgX, imgY

      if (imageAspect > containerAspect) {
        // Image is wider - fit to height
        imgHeight = containerHeight
        imgWidth = imgHeight * imageAspect
        imgX = (containerWidth - imgWidth) / 2
        imgY = 0
      } else {
        // Image is taller - fit to width
        imgWidth = containerWidth
        imgHeight = imgWidth / imageAspect
        imgX = 0
        imgY = (containerHeight - imgHeight) / 2
      }

      setImageSize({
        width: imgWidth,
        height: imgHeight,
        x: imgX,
        y: imgY
      })
    }

    // Use ResizeObserver for better accuracy
    const resizeObserver = new ResizeObserver(() => {
      updateSize()
    })

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current)
      updateSize()
    }

    window.addEventListener('resize', updateSize)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updateSize)
    }
  }, [image])

  useEffect(() => {
    if (!isAnnotating) {
      setShowPrompt(false)
    }
  }, [isAnnotating])

  const handleMouseDown = (e) => {
    if (!isAnnotating) return

    const stage = e.target.getStage()
    const point = stage.getPointerPosition()

    setIsDrawing(true)
    setLines([...lines, {
      points: [point.x, point.y],
      stroke: '#ffffff',
      strokeWidth: 10,
      tension: 0.5,
      lineCap: 'round',
      lineJoin: 'round'
    }])
  }

  const handleMouseMove = (e) => {
    if (!isDrawing || !isAnnotating) return

    const stage = e.target.getStage()
    const point = stage.getPointerPosition()

    const lastLine = lines[lines.length - 1]
    lastLine.points = lastLine.points.concat([point.x, point.y])

    setLines([...lines.slice(0, -1), lastLine])
  }

  const handleMouseUp = () => {
    setIsDrawing(false)
    if (isAnnotating && containerRef.current) {
      const point = stageRef.current?.getPointerPosition()
      if (point) {
        const container = containerRef.current
        const promptWidth = 220
        const promptHeight = 40
        const x = Math.min(Math.max(point.x + 8, 8), container.offsetWidth - promptWidth - 8)
        const y = Math.min(Math.max(point.y + 8, 8), container.offsetHeight - promptHeight - 8)
        setPromptAnchor({ x, y })
        setShowPrompt(true)
      }
    }
  }

  const clearAnnotations = () => {
    setLines([])
    setRegeneratePrompt('')
    setShowPrompt(false)
  }

  const handleExportMask = () => {
    if (lines.length === 0) {
      alert('No annotations to export. Please draw something first.')
      return
    }

    const maskDataURL = exportMask()
    if (!maskDataURL) {
      console.error('Failed to export mask. Check console for details.')
      alert('Failed to export mask. Please ensure the image has loaded.')
      return
    }

    // Create a download link
    const link = document.createElement('a')
    link.download = 'mask.png'
    link.href = maskDataURL
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)

    // Also log to console for debugging
    console.log('Mask exported successfully. Size:', maskDataURL.length, 'bytes')
  }

  const exportMask = () => {
    if (!stageRef.current || !image) {
      console.error('Export mask: Stage or image not available')
      return null
    }

    if (imageSize.width === 0 || imageSize.height === 0) {
      console.error('Export mask: Image size not calculated yet')
      return null
    }

    if (lines.length === 0) {
      console.warn('Export mask: No lines to export')
      return null
    }

    try {
      // Create a hidden container for the temporary stage
      const tempContainer = document.createElement('div')
      tempContainer.style.position = 'absolute'
      tempContainer.style.left = '-9999px'
      tempContainer.style.top = '-9999px'
      document.body.appendChild(tempContainer)

      // Create a temporary stage for mask export (same size as image)
      const tempStage = new Konva.Stage({
        width: image.width,
        height: image.height,
        container: tempContainer
      })

      // Create black background layer
      const bgLayer = new Konva.Layer()
      const bgRect = new Konva.Rect({
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
        fill: '#000000'
      })
      bgLayer.add(bgRect)

      // Create white drawing layer
      const maskLayer = new Konva.Layer()
      
      // Scale factor: original image size / displayed image size (accounting for cover behavior)
      const scaleX = image.width / imageSize.width
      const scaleY = image.height / imageSize.height

      // Copy and scale all lines to match image dimensions
      // Adjust for image offset (x, y) in the container
      lines.forEach(line => {
        if (!line.points || line.points.length < 2) return

        const scaledPoints = []
        for (let i = 0; i < line.points.length; i += 2) {
          // Translate point relative to image position, then scale
          const x = (line.points[i] - imageSize.x) * scaleX
          const y = (line.points[i + 1] - imageSize.y) * scaleY
          // Clamp to image bounds
          scaledPoints.push(
            Math.max(0, Math.min(image.width, x)),
            Math.max(0, Math.min(image.height, y))
          )
        }

        if (scaledPoints.length >= 2) {
          const maskLine = new Konva.Line({
            points: scaledPoints,
            stroke: '#ffffff',
            strokeWidth: Math.max(1, line.strokeWidth * Math.min(scaleX, scaleY)),
            tension: line.tension,
            lineCap: 'round',
            lineJoin: 'round',
            globalCompositeOperation: 'source-over'
          })
          maskLayer.add(maskLine)
        }
      })

      tempStage.add(bgLayer)
      tempStage.add(maskLayer)

      // Export as data URL
      const dataURL = tempStage.toDataURL({
        pixelRatio: 1,
        mimeType: 'image/png'
      })

      // Cleanup
      tempStage.destroy()
      document.body.removeChild(tempContainer)

      return dataURL
    } catch (error) {
      console.error('Error exporting mask:', error)
      return null
    }
  }

  // Expose controls via ref
  useImperativeHandle(ref, () => ({
    exportMask,
    clearAnnotations,
    setAnnotating: (value) => setIsAnnotating(!!value),
    toggleAnnotating: () => setIsAnnotating(prev => !prev),
    getIsAnnotating: () => isAnnotating,
    hasAnnotations: () => lines.length > 0,
    getPrompt: () => regeneratePrompt.trim(),
    setPrompt: (value) => setRegeneratePrompt(value ?? '')
  }))

  if (!image) {
    return (
      <div style={{ 
        width: '100%', 
        height: '100%', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        backgroundColor: colors.background,
        color: colors.textSecondary
      }}>
        Loading image...
      </div>
    )
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Konva Stage */}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          position: 'relative'
        }}
      >
        <Stage
          ref={stageRef}
          width={stageSize.width}
          height={stageSize.height}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onTouchStart={handleMouseDown}
          onTouchMove={handleMouseMove}
          onTouchEnd={handleMouseUp}
          style={{
            cursor: isAnnotating ? 'crosshair' : 'default'
          }}
        >
          {/* Image layer */}
          <Layer name="image-layer">
            <KonvaImage
              image={image}
              width={imageSize.width}
              height={imageSize.height}
              x={imageSize.x}
              y={imageSize.y}
              imageSmoothingEnabled={true}
            />
          </Layer>

          {/* Drawing layer */}
          <Layer name="drawing-layer">
            {lines.map((line, i) => (
              <Line
                key={i}
                points={line.points}
                stroke={line.stroke}
                strokeWidth={line.strokeWidth}
                tension={line.tension}
                lineCap={line.lineCap}
                lineJoin={line.lineJoin}
                globalCompositeOperation="source-over"
              />
            ))}
          </Layer>
        </Stage>
      </div>
      {showPrompt && (
        <div
          style={{
            position: 'absolute',
            left: promptAnchor.x,
            top: promptAnchor.y,
            zIndex: 5,
            backgroundColor: colors.surfaceElevated,
            border: `1px solid ${colors.border}`,
            borderRadius: '8px',
            padding: '8px',
            boxShadow: '0 8px 20px rgba(0,0,0,0.35)'
          }}
        >
          <div style={{
            fontSize: '10px',
            textTransform: 'uppercase',
            letterSpacing: '0.6px',
            color: colors.textSecondary,
            marginBottom: '6px'
          }}>
            Change Request
          </div>
          <input
            value={regeneratePrompt}
            onChange={(e) => setRegeneratePrompt(e.target.value)}
            placeholder="e.g., change car color to red"
            style={{
              width: '220px',
              padding: '8px 10px',
              border: `1px solid ${colors.border}`,
              borderRadius: '6px',
              backgroundColor: colors.surface,
              color: colors.text,
              fontSize: '12px',
              fontFamily: 'inherit',
              outline: 'none'
            }}
          />
        </div>
      )}
    </div>
  )
})

export default AnnotatableImage
