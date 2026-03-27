# API Design

## Purpose

This document defines the backend API surface for the web portal and the AI Game Factory backend.

The API should allow the frontend to:
- create and manage projects
- upload specs
- trigger generation runs
- inspect run status
- fetch artifacts and reports

---

## Design principles

- keep the API resource-oriented
- expose project/run/artifact concepts clearly
- do not expose internal MCP details directly
- return structured status for long-running operations
- keep v1 simple

---

## Core resources

### Project
Represents one game factory project.

### Spec Bundle
Represents the current PRD/GDD/UI files attached to a project.

### Run
Represents one generation attempt.

### Artifact
Represents one generated artifact or report.

### Log
Represents status/log output from a run.

---

## Suggested endpoints

## Projects

### `POST /projects`
Create a new project.

Request example:
```json id="xmo7ql"
{
  "name": "Typing Survival",
  "platform": "android",
  "orientation": "portrait"
}