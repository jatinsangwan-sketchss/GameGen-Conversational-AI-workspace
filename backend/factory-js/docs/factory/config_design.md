
---

# `factory/config_design.md`

```md id="0q1wd4"
# Config Design

## Purpose

This document defines configuration for the AI Game Factory.

The factory should be configurable without changing code for:
- paths
- model settings
- execution behavior
- repair limits
- environment-specific settings

---

## Config sources

Recommended priority:
1. command-line arguments
2. environment variables
3. config file
4. defaults in code

This keeps local development flexible while allowing server deployment later.

---

## Config categories

### 1. Path config
Examples:
- starter template path
- Godot executable path
- storage root
- artifact root
- generated project root

### 2. Model config
Examples:
- default model name
- max tokens later if needed
- prompt directory path

### 3. Execution config
Examples:
- overwrite behavior
- bounded validation run duration
- headless mode default
- MCP enabled/disabled
- repair enabled/disabled

### 4. Repair config
Examples:
- max repair attempts
- strictness mode
- retry policy

### 5. Backend/server config
Examples:
- API host
- API port
- DB path
- log level

---

## Recommended environment variables

Examples:
- `FACTORY_STARTER_TEMPLATE_PATH`
- `FACTORY_GODOT_EXECUTABLE`
- `FACTORY_STORAGE_ROOT`
- `FACTORY_ARTIFACT_ROOT`
- `FACTORY_GENERATED_PROJECTS_ROOT`
- `FACTORY_DEFAULT_MODEL`
- `FACTORY_MAX_REPAIR_ATTEMPTS`
- `FACTORY_DEFAULT_PLATFORM`
- `FACTORY_LOG_LEVEL`

Optional:
- MCP-related variables depending on integration style

---

## Suggested config file shape

Example `factory_config.json`:

```json id="mfmf8r"
{
  "paths": {
    "starter_template": "/path/to/godot_starter",
    "godot_executable": "/path/to/godot",
    "storage_root": "./storage",
    "artifacts_root": "./storage/artifacts",
    "generated_projects_root": "./storage/generated_projects"
  },
  "model": {
    "default_model": "gpt-oss-20b"
  },
  "execution": {
    "default_platform": "android",
    "bounded_validation_seconds": 5,
    "use_headless_validation": true,
    "enable_repair": true
  },
  "repair": {
    "max_attempts": 3,
    "strict_validation": false
  },
  "logging": {
    "level": "INFO"
  }
}