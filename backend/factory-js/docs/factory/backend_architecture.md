# Backend Architecture

## Purpose

This document defines the backend architecture for the AI Game Factory.

The backend sits between:
- the web portal frontend
- the factory core

It is responsible for:
- project management
- spec storage
- run orchestration
- artifact serving
- log access
- future multi-user and server support

---

## High-level role

The backend should not contain factory generation logic directly.

Instead, it should:
- accept requests from the portal
- validate input
- persist metadata
- trigger the factory core
- monitor runs
- expose artifacts and status back to the portal

This keeps the backend clean and scalable.

---

## Main layers

### 1. API layer
Handles HTTP requests and responses.

Responsibilities:
- request validation
- response formatting
- auth hooks later
- endpoint routing

### 2. Service layer
Implements business logic.

Suggested services:
- project service
- spec service
- run service
- artifact service
- log service

### 3. Factory adapter layer
Bridges backend to factory modules.

Responsibilities:
- call runner
- pass file paths/config
- translate run progress into backend status updates
- collect artifact references

### 4. Persistence layer
Handles database and file storage access.

Responsibilities:
- save project records
- save run records
- save spec bundle references
- save artifact references
- save logs

---

## Core backend entities

### Project
Represents one game generation project.

### Spec Bundle
Represents PRD/GDD/UI files for a project.

### Factory Run
Represents one generation attempt.

### Artifact
Represents generated JSON, markdown, logs, or project output.

### Run Log
Represents structured stage-by-stage logs.

---

## Recommended backend responsibilities by phase

### Project management
- create project
- update metadata
- list projects
- get current project state

### Spec management
- upload specs
- replace specs
- version specs later
- expose current spec bundle

### Run management
- start run
- get run state
- get stage progress
- rerun project

### Artifact management
- list artifacts
- fetch artifact content/paths
- later compare artifacts across runs

### Log management
- fetch logs
- filter logs by stage
- show errors/warnings

---

## Factory adapter responsibilities

The backend should not directly call low-level generator functions from API handlers.

Instead use a factory adapter such as:
- `FactoryRunService`
or
- `FactoryOrchestrator`

This adapter should:
- resolve project paths
- resolve spec bundle paths
- call `runner.py`
- capture final result
- update DB records
- record artifact locations

---

## Run lifecycle

Suggested run lifecycle:
- created
- queued
- running
- validating
- repairing
- completed
- failed
- cancelled later

Even if v1 is simple and mostly synchronous, model this lifecycle now.

---

## Suggested backend structure

```text id="yhd81k"
backend/
├── app/
│   ├── api/
│   ├── services/
│   ├── models/
│   ├── storage/
│   ├── factory_adapter/
│   └── config/
└── main.py