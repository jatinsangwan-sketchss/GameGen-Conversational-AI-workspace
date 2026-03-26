Convert the following normalized game spec into a generation recipe JSON object.

You must follow this exact output contract:

{
  "project_name": "string",
  "starter_template": "string",
  "target_path": "string",
  "scenes_to_create": [
    {
      "path": "string",
      "root_type": "string",
      "root_name": "string",
      "nodes": [
        {
          "name": "string",
          "type": "string",
          "parent": "string",
          "script_path": "string"
        }
      ]
    }
  ],
  "scripts_to_create": [
    {
      "path": "string",
      "role": "string",
      "scene_owned": true,
      "dependencies": ["string"]
    }
  ],
  "systems_to_create": [
    {
      "path": "string",
      "role": "string"
    }
  ],
  "ui_to_create": [
    {
      "scene_path": "string",
      "purpose": "string"
    }
  ],
  "config_files_to_create": [
    {
      "path": "string",
      "purpose": "string"
    }
  ],
  "validation_checks": [
    {
      "id": "string",
      "description": "string"
    }
  ],
  "repair_hints": ["string"]
}

Important rules:
- Output JSON only.
- Do not include comments.
- Do not include markdown fences.
- Use the minimum scene structure required for the prototype.
- Use scene-owned scripts unless a shared system is clearly justified.
- Create only the scenes and scripts needed for the current prototype.
- Do not invent large reusable systems.
- UI scenes should stay minimal.
- Validation checks should focus on file existence, required nodes, and startup/runtime sanity.

Starter template:
{starter_template}

Target path:
{target_path}

Normalized game spec:
{normalized_game_spec_json}