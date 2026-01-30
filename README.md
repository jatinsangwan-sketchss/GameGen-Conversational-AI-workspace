# Nexverse - AI UI Generation Platform

A chat-driven AI UI generation web application where users can paste UI PRDs and iteratively refine UI screens using natural language.

## Architecture

### Core Principle
**UI specs are the source of truth. Images are disposable visual renderings derived from UI specs.**

### System Components

```
┌─────────────┐      ┌──────────────┐      ┌─────────────┐      ┌─────────────┐
│  Frontend   │─────▶│   Backend     │─────▶│    Warp     │─────▶│   OpenAI    │
│   (React)   │◀─────│  (Node.js)   │◀─────│  (Agent)    │◀─────│ (Images)    │
└─────────────┘      └──────────────┘      └─────────────┘      └─────────────┘
```

#### Frontend (React)
- **Left Panel**: Chat interface with AI agent
- **Right Panel**: Workspace displaying generated UI screens (images) and structured data
- **State Management**: 
  - `messages[]` → chat history
  - `artifacts[]` → workspace outputs (images, specs)

#### Backend (Node.js - Thin API Layer)
- **Role**: Thin forwarding layer
- **Endpoints**: 
  - `POST /api/chat` - Forwards user messages to Warp
  - `POST /api/chat/clear` - Clears session
- **Holds**: Only the Warp API key
- **Does NOT**: Call OpenAI directly, contain agent logic

#### Warp (Hosted Agent Runtime)
- **Role**: Agent orchestrator and runtime
- **Responsibilities**:
  - PRD understanding (using Warp's native LLM)
  - UI spec generation and editing
  - Storing UI specs in session memory
  - Converting UI specs → image prompts
  - Calling OpenAI Image API (gpt-image-1.5) for image generation
  - Returning structured outputs
- **Agent Definition**: Stored in Warp (one-time setup)
- **Session Memory**: Maintains UI specs per session

#### OpenAI
- **Usage**: ONLY for image generation
- **Model**: gpt-image-1.5
- **API Key**: Configured inside Warp
- **Never called by**: Frontend or Backend directly

## Data Flow

### Initial Flow (PRD → Screens)
1. User pastes PRD into chat
2. Frontend sends PRD to backend
3. Backend calls `warp.run(agentId, input)`
4. Warp:
   - Loads agent definition
   - Uses native LLM to generate `ui_specs` for all screens
   - Stores `ui_specs` in session memory
   - Converts `ui_specs` → image prompts
   - Calls OpenAI Image API
5. Warp returns artifacts (`ui_specs` + `images`)
6. Frontend renders images in workspace

### Edit Flow (Iteration)
Example: "In the 4th screen, change the button size to 100px"

1. Frontend sends edit request to backend
2. Backend forwards to Warp
3. Warp:
   - Loads `ui_specs` from session memory
   - Identifies target screen and component
   - Updates the `ui_spec` only (never edits images directly)
   - Regenerates image for that screen
4. Warp returns updated `ui_spec` + new `image`
5. Frontend updates only that screen

## Artifact Structure

Warp returns artifacts in this format:

```json
{
  "chat": "I've updated the button size.",
  "artifacts": [
    {
      "type": "ui_spec",
      "screen": "Login",
      "content": {
        "screen": "Login",
        "layout": "vertical",
        "components": [...]
      }
    },
    {
      "type": "image",
      "screen": "Login",
      "content": {
        "url": "https://..."
      }
    }
  ]
}
```

## Setup

### Backend

1. Navigate to backend:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file:
```env
# Warp Configuration (Required)
WARP_API_URL=https://api.warp.dev/v1
WARP_API_KEY=your_warp_api_key_here
WARP_AGENT_ID=your_agent_id_here

# Note: OpenAI API key is configured in Warp, not here
```

4. Start backend:
```bash
npm start
```

The backend runs on `http://localhost:3001`

### Frontend

1. Navigate to frontend:
```bash
cd frontend
```

2. Install dependencies:
```bash
npm install
```

3. Start development server:
```bash
npm run dev
```

The frontend runs on `http://localhost:5173`

## Warp Agent Configuration

The agent definition is configured in Warp (one-time setup). It includes:

- **System Prompt**: Defines the agent as an AI UI designer
- **Rules**:
  - Generate structured UI specs from PRDs
  - Store UI specs in session memory
  - Never edit images directly
  - On edits, modify UI specs and regenerate images
- **Tools**:
  - Warp native LLM (text + reasoning)
  - OpenAI image generation (gpt-image-1.5)
- **Output Format**: 
  ```json
  {
    "chat": string,
    "artifacts": [
      { "type": "ui_spec" | "image", "screen": string, "content": object }
    ]
  }
  ```

## Important Constraints

- ✅ **Never edit images directly** - Always modify UI specs
- ✅ **Never store images as truth** - UI specs are source of truth
- ✅ **Always regenerate images from ui_specs** - Images are disposable
- ✅ **Keep backend thin** - Only forwards to Warp
- ✅ **Keep frontend keyless** - No API keys in frontend
- ✅ **All intelligence lives in Warp** - Agent logic, reasoning, image generation

## Usage

1. Start both backend and frontend servers
2. Open the frontend in your browser
3. Paste a UI PRD or describe what you want:
   - "Create a login screen with email and password fields"
   - "Generate a dashboard with 4 metric cards"
4. View generated UI screens in the right panel
5. Iterate with natural language:
   - "Make the button larger"
   - "Change the background color to dark grey"
   - "Add a header to the dashboard"

## Project Structure

```
ai-ui-agent-app/
├── backend/
│   ├── index.js          # Express server & API routes (thin layer)
│   ├── llm-service.js    # Warp API integration
│   ├── package.json
│   └── .env              # Warp API key only
├── frontend/
│   ├── src/
│   │   ├── App.jsx       # Main React component
│   │   ├── Logo.jsx     # Nexverse logo component
│   │   └── main.jsx     # React entry point
│   ├── index.html
│   └── package.json
└── README.md
```

## Environment Variables

### Backend (.env)
```env
WARP_API_URL=https://api.warp.dev/v1
WARP_API_KEY=your_warp_api_key_here
WARP_AGENT_ID=your_agent_id_here
```

**Note**: OpenAI API key is configured in Warp, not in the backend.

## Troubleshooting

- **Backend connection errors**: Ensure backend is running on port 3001
- **Warp errors**: Check `WARP_API_KEY` and `WARP_AGENT_ID` in `.env`
- **No images appearing**: Verify Warp agent is configured to call OpenAI Image API
- **CORS errors**: Backend has CORS enabled for localhost development
- **Session not persisting**: Ensure `sessionId` is being passed consistently

## Mental Model

```
User Intent
    ↓
Warp Native LLM (Reasoning)
    ↓
UI Spec (Source of Truth)
    ↓
Image Prompt (Renderer Input)
    ↓
OpenAI Image Model (gpt-image-1.5)
    ↓
UI Screen Image
```

## Notes

- The system uses session-based memory in Warp to maintain UI specs
- Images are regenerated on every spec change
- All agent intelligence and logic lives in Warp
- Backend is intentionally thin - just a forwarding layer
- Frontend is keyless - no API keys exposed to client
