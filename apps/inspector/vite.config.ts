import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/inspector/",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/inspector/api": "http://127.0.0.1:4310",
      "/memories": "http://127.0.0.1:4310",
      "/sessions": "http://127.0.0.1:4310",
      "/spaces": "http://127.0.0.1:4310"
    }
  }
});
