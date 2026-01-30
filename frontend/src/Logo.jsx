// Modern font stack matching Nexverse aesthetic
export const nexverseFont = '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif'

// Import the actual logo image
import nexverseLogo from "./assets/Nexverse_logo.png"

// Nexverse Logo Component - Uses actual logo image
export function NexverseLogo({ size = 48, showText = true, dark = false }) {
  const textColor = dark ? '#1a1a1a' : '#ffffff'
  
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      {/* Logo Image */}
      <img 
        src={nexverseLogo} 
        alt="Nexverse Logo" 
        style={{ 
          height: `${size}px`,
          width: 'auto',
          flexShrink: 0
        }}
      />
      
      {/* Text "nxv" - lowercase, modern, geometric */}
      {/* {showText && (
        <div style={{
          fontFamily: nexverseFont,
          fontSize: `${size * 0.9}px`,
          fontWeight: '600',
          color: textColor,
          letterSpacing: '1.2px',
          lineHeight: '1',
          fontFeatureSettings: '"liga" off, "kern" 1'
        }}>
          nxv
        </div>
      )} */}
    </div>
  )
}

export default NexverseLogo
