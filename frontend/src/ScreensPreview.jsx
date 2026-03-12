import { useEffect } from 'react'
import { buildAssetUrl } from './utils/assetUtils'

function ScreenMockup({ screen }) {
  if (!screen?.image) return null
  const imageUrl = buildAssetUrl(screen.image)
  return (
    <img
      src={imageUrl}
      alt={`${screen.name || 'screen'} mockup`}
      style={{
        width: '100%',
        height: 'auto',
        borderRadius: '12px',
        display: 'block'
      }}
    />
  )
}

export default function ScreensPreview({ screens = [], assets = {} }) {
  if (!screens.length) {
    return null
  }

  useEffect(() => {
    console.log('[screens] screens metadata:', screens)
    console.log('[screens] assets metadata:', assets)
  }, [screens, assets])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {screens.map((screen) => (
        <div key={screen.name}>
          <div style={{
            margin: '0 0 12px 0',
            fontSize: '16px',
            fontWeight: '700',
            textTransform: 'uppercase',
            letterSpacing: '0.6px',
            color: '#e0e0e0'
          }}>
            {screen.name}
          </div>
          <div style={{
            width: '100%',
            maxWidth: '520px',
            borderRadius: '16px',
            padding: '12px',
            backgroundColor: '#000',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            display: 'flex',
            justifyContent: 'center'
          }}>
            <ScreenMockup screen={screen} />
          </div>
        </div>
      ))}
    </div>
  )
}
