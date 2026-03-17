import { buildAssetUrl } from '../utils/assetUtils'

export default function AssetShelf({
  assets = [],
  onDragStart,
  disabled = false
}) {
  if (!assets.length) {
    return (
      <div style={{ color: '#666666', fontSize: '13px' }}>
        No assets for this screen yet.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {assets.map((asset) => {
        const url = buildAssetUrl(asset.path)
        return (
          <div
            key={asset.id}
            style={{
              border: '1px solid #2a2a2a',
              borderRadius: '10px',
              padding: '10px',
              backgroundColor: '#121212',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px'
            }}
          >
            <img
              src={url}
              alt={asset.id}
              draggable={!disabled}
              onDragStart={(event) => !disabled && onDragStart?.(asset, event)}
              style={{
                width: '100%',
                height: '120px',
                objectFit: 'contain',
                borderRadius: '6px',
                backgroundColor: '#1a1a1a',
                cursor: disabled ? 'not-allowed' : 'grab',
                opacity: disabled ? 0.65 : 1
              }}
            />
            <div style={{
              fontSize: '12px',
              color: '#a0a0a0',
              wordBreak: 'break-word'
            }}>
              {asset.fileName || asset.id}
            </div>
          </div>
        )
      })}
    </div>
  )
}
