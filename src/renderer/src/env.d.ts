/// <reference types="vite/client" />

import type { DefineComponent } from "vue"
import type { DeskApi } from "../../shared/desk"

declare module "*.vue" {
  const component: DefineComponent
  export default component
}

declare global {
  interface Window {
    desk: DeskApi
  }
}

export {}
