# Nexverse - AI UI Asset Generation Platform

Chat-driven AI workflow for generating game UI assets from PRDs, composing screens in a manual layout editor, and safely annotating individual assets.

## Architecture (Current)

### Core Principle
**Assets are generated first. Layout is manual. No composite AI screen generation.**

### System Components

```
┌─────────────┐      ┌──────────────┐      ┌──────────────┐
│  Frontend   │─────▶│   Backend     │─────▶│   OpenAI     │
│   (React)   │◀─────│  (Node.js)    │◀─────│ (Text/Image) │
└─────────────┘      └──────────────┘      └──────────────┘
         │
         ▼
     Local Assets
   /assets/... (PNG)
```

### Frontend (React)
- **Left Panel**: Conversational PRD input and status logs
- **Right Panel**: Layout Workspace
  - Asset Shelf (per screen)
  - 9:16 canvas (react-konva)
  - Save Layout
  - Annotate Mode for single-asset edits

### Backend (Node.js)
- **Intent + extraction**: PRD → design context + structured screens
- **Asset generation**: OpenAI image generation + Comfy trim
- **Endpoints**:
  - `POST /api/chat`
  - `POST /api/chat/clear`
  - `POST /api/layout/save`
  - `POST /api/edit-asset`
- **Asset storage**:
  - `/assets/<game>/<screen>/<asset>.png`
- **Layout storage**:
  - `/layouts/<game>/<screen>.json`

## Data Flow

### PRD → Assets
1. User submits PRD in chat
2. Backend:
   - Extracts design context
   - Extracts rich component specs
   - Generates assets (backgrounds use 9:16)
   - Runs Comfy trim
3. Frontend receives:
   - `screens` (component metadata)
   - `assets` (file paths)

### Layout Editing
1. User drags assets into 9:16 canvas
2. User positions/resizes assets
3. Save layout → `/layouts/<game>/<screen>.json`

### Annotate Mode (single-asset edit)
1. Toggle Annotate mode
2. Select one asset
3. Submit edit instruction
4. Backend edits original asset, trims, overwrites PNG
5. Canvas refreshes

## API Response Shape

`POST /api/chat` returns:
```json
{
  "chat": "string",
  "screens": [],
  "assets": {},
  "designContext": "string|null"
}
```

## Setup

### Backend
```bash
cd backend
npm install
npm start
```

Create `.env`:
```env
OPENAI_API_KEY=your_openai_key
COMFY_BASE_URL=http://127.0.0.1:8000
COMFY_INPUT_DIR=/path/to/ComfyUI/input
COMFY_OUTPUT_DIR=/path/to/ComfyUI/output
```

Backend runs on `http://localhost:3001`.

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`.

## Project Structure

```
ai-ui-agent-app/
├── backend/
│   ├── index.js
│   ├── services/
│   │   ├── extraction/
│   │   ├── generation/
│   │   ├── comfy/
│   │   └── editAssetService.js
│   ├── assets/          # Generated PNGs
│   ├── layouts/         # Saved layout JSON
│   └── .env
├── frontend/
│   └── src/
│       ├── components/
│       └── api/
└── README.md
```

## Notes
- Assets are generated per screen and trimmed for clean edges.
- Layouts are saved separately and do not mutate assets.
- Annotate Mode edits **one asset at a time** with strict safety rules.
