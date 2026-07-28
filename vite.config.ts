import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  cacheDir: ".vite-cache",
  build: {
    target: "es2022",
    sourcemap: true,
    emptyOutDir: false,
  },
});
