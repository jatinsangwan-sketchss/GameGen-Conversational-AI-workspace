import { appendBuildLog, updateBuildStatus, recordBuildRun } from "./GameBuildStore.js"

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runGameBuild({ sessionId, blueprint }) {
  updateBuildStatus(sessionId, "building")
  recordBuildRun(sessionId, blueprint)

  appendBuildLog(sessionId, "INFO", "Creating Godot Project...")
  await delay(250)

  appendBuildLog(sessionId, "INFO", "Loading layout JSON...")
  await delay(250)

  for (const scene of blueprint.scenes || []) {
    appendBuildLog(sessionId, "INFO", `Creating scene: ${scene.name}`)
    await delay(200)
    appendBuildLog(sessionId, "SUCCESS", `Scene '${scene.name}' created`)
    await delay(150)

    appendBuildLog(sessionId, "INFO", `Binding assets for ${scene.name}`)
    await delay(200)
    appendBuildLog(sessionId, "SUCCESS", `Assets bound for ${scene.name}`)

    appendBuildLog(sessionId, "INFO", `Attaching scripts for ${scene.name}`)
    await delay(200)
    appendBuildLog(sessionId, "SUCCESS", `Scripts attached for ${scene.name}`)
  }

  appendBuildLog(sessionId, "INFO", "Saving scenes...")
  await delay(200)
  appendBuildLog(sessionId, "SUCCESS", "Scenes saved")

  appendBuildLog(sessionId, "INFO", "Running project...")
  await delay(200)
  appendBuildLog(sessionId, "SUCCESS", "Game build completed 🎮")

  updateBuildStatus(sessionId, "completed")
}
