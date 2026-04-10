# GDD

## Game Overview
The player survives in the center of the screen while letters spawn around them and move inward. The player types matching letters on the mobile keyboard to destroy the incoming letters. The game continues until an enemy reaches the player.

## Core Mechanic
Type the letter shown on an enemy to destroy it.

## Controls
Mobile keyboard input.

## Game Flow
Start gameplay -> letters spawn -> player types matching letters -> letters are destroyed -> difficulty rises -> player fails when hit -> show result

## Core Loop
- enemy letter spawns
- enemy moves toward player
- player types matching letter
- matching enemy is destroyed
- more letters continue spawning
- survive as long as possible

## Win Conditions
No win state in M1. Endless survival.

## Fail Conditions
A letter enemy reaches the player.

## Score / Reward Logic
Primary score is survival time.
Optional secondary metric later: letters destroyed.

## Progression / Meta
Out of scope for M1.

## Difficulty Model
Difficulty increases over time by:
- shorter spawn intervals
- slightly faster average movement
- more overlapping pressure

For M1, only basic speed variation is required:
- slow letters
- fast letters

## Content Structure
Endless survival session.

## Feedback Goals
- typed input should feel immediate
- destroyed letters should disappear clearly
- threat should be easy to read
- fast letters should feel scary but fair

## Audio / Visual Feel
Clean, readable, arcade-like, high contrast.

## Notes for Implementation
- avoid screen clutter
- keep keyboard-safe gameplay area
- ensure typed input is visible and responsive
- spawn positions should not overlap the player
- basic duplicate-letter handling should be predictable