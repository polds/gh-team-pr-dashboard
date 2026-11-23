import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = "http://localhost:8080";

export default defineConfig({
	plugins: [react()],
	build: { outDir: "dist", emptyOutDir: true },
	server: {
		proxy: {
			"/api": server,
			"/auth": server,
			"/demo": server,
		},
	},
});
