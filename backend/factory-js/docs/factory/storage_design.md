
---

# `factory/storage_design.md`

```md id="hwsjfk"
# Storage Design

## Purpose

This document defines how the AI Game Factory stores:
- projects
- specs
- artifacts
- generated project outputs
- logs
- metadata

Storage design should support:
- local development now
- server deployment later

---

## Storage categories

### 1. Metadata storage
Store project/run/spec metadata in a database.

Examples:
- project name
- platform
- run status
- artifact paths
- timestamps

### 2. File storage
Store actual files on disk or object storage later.

Examples:
- PRD/GDD/UI markdown
- normalized spec JSON
- generation recipe JSON
- validation report JSON
- repair report JSON
- run summary markdown
- generated project folders

---

## Recommended v1 storage model

### Metadata
Use a simple DB:
- SQLite is fine for v1

### Files
Use local filesystem:
- one root directory for specs
- one root directory for generated projects
- one root directory for artifacts
- one root directory for logs

---

## Recommended directory layout

```text id="0wc7a8"
storage/
├── specs/
│   └── <project_id>/
├── artifacts/
│   └── <project_id>/
│       └── <run_id>/
├── generated_projects/
│   └── <project_id>/
│       └── <run_id>/
└── logs/
    └── <project_id>/
        └── <run_id>/