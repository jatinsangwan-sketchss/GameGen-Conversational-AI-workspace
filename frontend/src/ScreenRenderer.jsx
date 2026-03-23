import { nexverseFont } from './Logo'
import { buildAssetUrl } from './utils/assetUtils'

function findAssetsForComponent(assets, componentName) {
  if (!componentName) return []
  const name = String(componentName)
  return assets.filter((asset) => asset?.id?.includes(name))
}

function isBackgroundComponent(component) {
  if (!component) return false
  const name = String(component.name || '').toLowerCase()
  const type = String(component.type || '').toLowerCase()
  return type === 'background' || name === 'background' || name.includes('background')
}

export default function ScreenRenderer({ screen, assets = [] }) {
  const layout = screen?.layout || { type: 'vertical', sections: [] }
  const sections = Array.isArray(layout.sections) ? layout.sections : []
  const components = Array.isArray(screen.components) ? screen.components : []

  const backgroundComponents = components.filter(isBackgroundComponent)
  const backgroundAssets = backgroundComponents.flatMap((comp) =>
    findAssetsForComponent(assets, comp.name)
  )

  const layoutType = layout.type || 'vertical'
  const containerStyle = {
    position: 'relative',
    width: '100%',
    height: '100%',
    borderRadius: '12px',
    overflow: 'hidden',
    backgroundColor: '#0a0a0a',
    border: '1px solid #333333'
  }

  const sectionStyle = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '12px',
    padding: '16px'
  }

  const layoutStyle = {
    display: layoutType === 'grid' ? 'grid' : 'flex',
    flexDirection: layoutType === 'vertical' ? 'column' : undefined,
    gap: '12px'
  }

  if (layoutType === 'grid') {
    layoutStyle.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))'
  }

  return (
    <div style={containerStyle}>
      {/* Background layer */}
      {backgroundAssets.map((asset) => (
        <img
          key={asset.id}
          src={buildAssetUrl(asset.path)}
          alt={asset.id}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover'
          }}
        />
      ))}

      {/* Layout sections */}
      <div style={{ position: 'relative', zIndex: 2, ...layoutStyle }}>
        {sections.map((section) => {
          const componentNames = Array.isArray(section.components) ? section.components : []
          const sectionAssets = componentNames.flatMap((name) =>
            findAssetsForComponent(assets, name)
          )

          const sectionContainerStyle =
            layoutType === 'overlay'
              ? {
                  position: 'absolute',
                  inset: 0,
                  ...sectionStyle
                }
              : sectionStyle

          return (
            <div key={section.id || section.title || Math.random()} style={sectionContainerStyle}>
              {sectionAssets.map((asset) => (
                <img
                  key={asset.id}
                  src={buildAssetUrl(asset.path)}
                  alt={asset.id}
                  style={{
                    maxWidth: '100%',
                    height: 'auto',
                    borderRadius: '8px',
                    border: '1px solid #2a2a2a',
                    backgroundColor: '#1a1a1a'
                  }}
                />
              ))}
            </div>
          )
        })}
      </div>

      <div style={{
        position: 'absolute',
        top: '10px',
        left: '12px',
        fontSize: '11px',
        textTransform: 'uppercase',
        letterSpacing: '1px',
        color: '#a0a0a0',
        fontFamily: nexverseFont
      }}>
        {screen?.name || 'Screen'}
      </div>
    </div>
  )
}
