import { buildAssetUrl } from './utils/assetUtils'

function findAssetForComponent(assets, componentName) {
  if (!componentName) return null
  const name = String(componentName)
  return assets.find((asset) => {
    const idMatch = asset?.id?.includes(name)
    const fileMatch = asset?.fileName?.includes(name)
    return idMatch || fileMatch
  })
}

function sortByZIndex(components) {
  return [...components].sort((a, b) => {
    const aZ = Number(a?.layout?.zIndex ?? 0)
    const bZ = Number(b?.layout?.zIndex ?? 0)
    return aZ - bZ
  })
}

export default function AbsoluteScreenRenderer({ screen, assets = [] }) {
  const components = Array.isArray(screen?.components) ? screen.components : []
  const ordered = sortByZIndex(components)

  if (screen) {
    console.log(`[renderer] screen: ${screen.name}`, {
      componentCount: components.length,
      assetsCount: assets.length
    })
  }

  return (
    <div style={{
      width: '375px',
      maxWidth: '100%',
      aspectRatio: '9 / 16',
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: '#0a0a0a',
      borderRadius: '24px',
      border: '1px solid #333333'
    }}>
      {ordered.map((component) => {
        const asset = findAssetForComponent(assets, component.name)
        if (!asset) return null

        const layout = component.layout || {}
        const left = (layout.x ?? 0.5) * 100
        const top = (layout.y ?? 0.5) * 100
        const width = (layout.width ?? 0.2) * 100
        const height = (layout.height ?? 0.2) * 100
        const zIndex = Number(layout.zIndex ?? 0)

        return (
          <img
            key={`${screen?.name || 'screen'}-${component.name}`}
            src={buildAssetUrl(asset.path)}
            alt={component.name}
            style={{
              position: 'absolute',
              left: `${left}%`,
              top: `${top}%`,
              width: `${width}%`,
              height: `${height}%`,
              transform: 'translate(-50%, -50%)',
              zIndex,
              objectFit: 'contain',
              pointerEvents: 'none'
            }}
          />
        )
      })}
    </div>
  )
}
