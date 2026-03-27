# Manual Setup Checklist

Use this file to track editor-side setup that code cannot guarantee.

## For each feature, note:
- required scene nodes
- signal connections
- exported variable assignments
- autoload setup
- input map entries
- test scene wiring

## Example format

### Feature
Fail popup retry flow

### Required nodes
- CanvasLayer
- FailPopup panel
- RetryButton

### Required connections
- RetryButton.pressed -> fail_popup.gd callback

### Required assignments
- fail_popup.gd needs reference to game manager

### Validation
- fail popup appears on fail
- retry restarts run