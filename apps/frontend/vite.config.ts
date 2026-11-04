import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      "/agents": "http://127.0.0.1:3001",
      "/runs": "http://127.0.0.1:3001",
      "/traces": "http://127.0.0.1:3001",
    },
  },
  preview: {
    port: 3000,
    strictPort: true,
  },
});
