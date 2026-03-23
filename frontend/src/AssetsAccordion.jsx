import { buildAssetUrl } from './utils/assetUtils'

export default function AssetsAccordion({ assets = {} }) {
  const screenNames = Object.keys(assets)

  if (!screenNames.length) {
    return null
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {screenNames.map((screenName) => {
        const screenAssets = assets[screenName] || []
        return (
          <details key={screenName} style={{
            border: '1px solid #333333',
            borderRadius: '10px',
            backgroundColor: '#1f1f1f',
            padding: '10px 12px'
          }}>
            <summary style={{
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: '700',
              color: '#e0e0e0',
              letterSpacing: '0.5px',
              textTransform: 'uppercase'
            }}>
              {screenName} ({screenAssets.length})
            </summary>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: '12px',
              marginTop: '12px'
            }}>
              {screenAssets.map((asset) => {
                const url = buildAssetUrl(asset.path)
                return (
                  <div key={asset.id} style={{
                    border: '1px solid #2a2a2a',
                    borderRadius: '10px',
                    padding: '10px',
                    backgroundColor: '#121212',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px'
                  }}>
                    <img
                      src={url}
                      alt={asset.id}
                      style={{
                        width: '100%',
                        height: '120px',
                        objectFit: 'contain',
                        borderRadius: '6px',
                        backgroundColor: '#1a1a1a'
                      }}
                    />
                    <div style={{
                      fontSize: '12px',
                      color: '#a0a0a0',
                      wordBreak: 'break-word'
                    }}>
                      {asset.fileName || asset.id}
                    </div>
                    <a
                      href={url}
                      download={asset.fileName || asset.id}
                      style={{
                        display: 'inline-block',
                        textAlign: 'center',
                        padding: '8px 10px',
                        borderRadius: '6px',
                        backgroundColor: '#3b82f6',
                        color: '#fff',
                        textDecoration: 'none',
                        fontSize: '12px',
                        fontWeight: '600'
                      }}
                    >
                      Download
                    </a>
                  </div>
                )
              })}
            </div>
          </details>
        )
      })}
    </div>
  )
}
