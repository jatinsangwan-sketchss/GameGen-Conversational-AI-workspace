Convert the following PRD, GDD, and UI spec into one normalized JSON object.

You must follow this exact output contract:

{
  "project_name": "string",
  "platform": "android | ios | pc | web",
  "orientation": "portrait | landscape",
  "genre": "string",
  "summary": "string",
  "core_loop": "string",
  "player_fantasy": "string",
  "input_model": {
    "type": "string",
    "rules": ["string"]
  },
  "fail_condition": "string",
  "score_model": "string",
  "difficulty_model": "string",
  "scenes": [
    {
      "name": "string",
      "purpose": "string"
    }
  ],
  "ui": {
    "screens": ["string"],
    "hud_elements": ["string"],
    "layout_notes": ["string"]
  },
  "entities": [
    {
      "name": "string",
      "role": "string",
      "behavior_notes": ["string"]
    }
  ],
  "systems": ["string"],
  "out_of_scope": ["string"],
  "acceptance_criteria": ["string"],
  "open_questions": ["string"]
}

Important rules:
- Output JSON only.
- Do not include comments.
- Do not include markdown fences.
- Do not invent progression, monetization, analytics, save, or meta systems unless explicitly supported by the documents.
- If a field is unclear, use an empty string or empty array where appropriate instead of guessing.
- Keep the result implementation-oriented.
- Scenes should reflect the minimum required prototype structure.
- Systems should only include truly justified shared systems.

Project name:
{project_name}

Platform:
{platform}

Orientation:
{orientation}

PRD:
{prd_text}

GDD:
{gdd_text}

UI spec:
{ui_spec_text}