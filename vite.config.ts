import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    headers: {
      "Cache-Control": "no-store",
      "Clear-Site-Data": "\"cache\", \"storage\""
    }
  }
});
