# UI Spec

## UI Goal
Support fast, readable mobile typing gameplay while preserving enough space above the keyboard for incoming enemies.

## Screens
- Main Menu
- Gameplay
- Fail / Result Popup

## Gameplay Layout
Gameplay must reserve bottom screen space for the mobile keyboard.
The active gameplay field should remain visible above the keyboard.

## Gameplay HUD
Required elements:
- survival time
- optional letters destroyed count
- optional small status text for testing

## Main Menu
Required elements:
- Play button
- Title

## Fail Popup
Required elements:
- survival time result
- retry button
- menu button

## UI Behavior Rules
- gameplay begins with keyboard active or quickly activatable
- HUD should not overlap important enemy movement area
- fail popup should clearly show end of run and retry option

## UI Clarity Goals
- player can always see enemy letters clearly
- central player position remains visible
- keyboard does not cover critical gameplay space
- typed letter matching should feel obvious

## Style Notes
Minimal, high contrast, readable fonts, low visual noise.

## Animation / Feedback Notes
- enemy destruction should be immediate and readable
- fail should be visually clear
- timers and score updates should be easy to see