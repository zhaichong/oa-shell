import { resolve } from "node:path"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "electron-vite"

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          oa: resolve("src/preload/oa.js")
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src")
      }
    },
    plugins: [vue()]
  }
})
