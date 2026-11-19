import path from "node:path"
import { app } from "electron"

declare const __dirname: string

function currentDir(): string {
  return __dirname
}

export function projectRoot(): string {
  return path.resolve(currentDir(), "../..")
}

export function resourcePath(...parts: string[]): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "oa-shell", ...parts)
  }
  return path.join(projectRoot(), ...parts)
}

export function preloadPath(fileName: string): string {
  return path.join(currentDir(), "../preload", fileName)
}

export function rendererHtml(): string {
  return path.join(currentDir(), "../renderer/index.html")
}
