import { sessionRepository } from "./repositories/SessionRepository.js"

export const sessions = sessionRepository.sessions

export function getSession(sessionId) {
  return sessionRepository.get(sessionId)
}

export function checkSession(sessionId) {
  return sessionRepository.has(sessionId)
}

export function deleteSession(sessionId) {
  sessionRepository.delete(sessionId)
}

// /assets/<game_name>/<screen_name>/<png file> ------ this is the folder structure for our assets
//
// Session shape:
// {
//   designContext: string | null,
//   originalPRD: string | null,
//   screensMetadata: [
//     {
//       name: string,
//       description: string,
//       components: [
//         {
//           type: string,
//           name: string,
//           label: string | null,
//           variant: string | null,
//           purpose: string,
//           visual_style: string,
//           shape: string,
//           material: string,
//           colors: string,
//           must_include: string[],
//           must_not_include: string[],
//           text_strategy: "render_text_in_engine" | "render_text_in_asset",
//           composition_rule: "container_only" | "icon_only" | "none"
//         }
//       ]
//     }
//   ],
//   assets: { [screenName: string]: array },
//   gameName: string | null,
//   lastExtractionAt: string | null,
//   lastAssetGenerationAt: string | null
// }