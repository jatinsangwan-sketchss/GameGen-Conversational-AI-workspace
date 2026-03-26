
---

# `factory/web_portal_architecture.md`

```md id="3kgbqv"
# Web Portal Architecture

## Purpose

This document defines the web portal architecture for the AI Game Factory.

The portal is the frontend for the factory.
It should allow users to:
- create projects
- upload PRD/GDD/UI specs
- configure generation runs
- monitor run status
- inspect logs and reports
- review artifacts
- manage generated projects

The portal should be designed so the factory can later run on a server.

---

## High-level architecture

The system should be split into:

### 1. Frontend
Browser-based portal UI.

### 2. Backend API
Application server that exposes factory operations.

### 3. Factory Core
The generation engine that runs planning, generation, validation, and repair.

### 4. Storage
Stores:
- specs
- artifacts
- logs
- generated projects
- run metadata

---

## Frontend responsibilities

The frontend should provide:

### Project management
- create project
- list projects
- open project
- view latest run

### Spec management
- upload PRD
- upload GDD
- upload UI spec
- view current specs
- version specs later

### Run control
- start generation run
- view current stage
- cancel run later
- rerun with updated inputs

### Artifact review
- view normalized spec
- view generation recipe
- view validation report
- view repair report
- view summaries

### Logs and status
- stage status
- current step
- errors/warnings
- repair attempts

### Future review features
- approve/reject generated build
- compare runs
- mark prototype as promising/rejected

---

## Backend responsibilities

The backend should:
- expose API endpoints
- persist project/run metadata
- trigger factory runs
- track run status
- store artifact references
- serve logs and summaries
- later support authentication and multi-user access

---

## Factory core responsibilities

The factory core should remain backend-internal.

It should:
- read specs
- run the factory pipeline
- create artifacts
- update run status
- return structured results to backend

The frontend should not call MCP or CLI directly.

---

## Storage responsibilities

Storage should keep:

### Project data
- project metadata
- project config
- current status

### Spec files
- PRD
- GDD
- UI spec

### Artifact files
- normalized spec JSON
- generation recipe JSON
- validation reports
- repair reports
- run summaries

### Generated project outputs
- generated Godot project folders
- build outputs later

### Logs
- run logs
- stage logs
- executor logs

---

## Recommended v1 portal pages

### 1. Dashboard
List all projects and recent runs.

### 2. Project page
Show:
- project info
- uploaded specs
- latest run
- artifact links

### 3. New project page
Create a new factory project.

### 4. Run page
Show:
- current stage
- status
- logs
- validation result
- repair result

### 5. Artifact viewer page
Show generated JSON/markdown summaries and reports.

---

## Recommended backend model objects

### Project
- id
- name
- platform
- orientation
- created_at
- updated_at
- latest_run_id

### SpecBundle
- id
- project_id
- prd_path
- gdd_path
- ui_spec_path
- version

### FactoryRun
- id
- project_id
- status
- current_stage
- started_at
- finished_at
- normalized_spec_path
- generation_recipe_path
- validation_report_path
- repair_report_path
- summary_path

### RunLog
- id
- run_id
- stage
- level
- message
- timestamp

---

## Status model

Suggested statuses:
- created
- specs_uploaded
- ready_to_run
- running
- validating
- repairing
- completed
- failed
- cancelled

---

## Recommended v1 architecture style

For v1:
- simple frontend
- simple backend API
- synchronous or pseudo-async runs initially
- single-user or small-team oriented
- no complex auth required yet unless needed

---

## Future scalability goals

Later, the portal should support:
- multiple users
- background jobs
- queued runs
- run history comparison
- model selection
- remote artifact storage
- server-side Godot execution workers

---

## Core design rule

The portal should be a client of the backend API.
The backend API should be the client of the factory core.
The factory core should be the client of MCP/CLI.

Keep these layers separate.