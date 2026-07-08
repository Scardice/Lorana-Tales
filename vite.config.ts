import path from "node:path";
import vue from "@vitejs/plugin-vue";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";
import { NaiveUiResolver } from "unplugin-vue-components/resolvers";

import Components from "unplugin-vue-components/vite";
import { defineConfig } from "vite";

const pathWeb = path.resolve(__dirname, "web");
const pathSrc = path.resolve(pathWeb, "src");

// https://vitejs.dev/config/
export default defineConfig({
	root: pathWeb,
	resolve: {
		alias: {
			"~/": `${pathSrc}/`,
		},
	},
	build: {
		outDir: path.resolve(__dirname, "out"),
		emptyOutDir: true,
		rollupOptions: {
			input: {
				main: path.resolve(pathWeb, "index.html"),
				admin: path.resolve(pathWeb, "admin.html"),
				apiDocs: path.resolve(pathWeb, "api-docs.html"),
				securityWarning: path.resolve(pathWeb, "security-warning.html"),
			},
		},
	},
	css: {
		postcss: {
			plugins: [tailwindcss(), autoprefixer()],
		},
	},
	base: "./",
	plugins: [
		vue(),
		Components({
			// allow auto load markdown components under `./src/components/`
			extensions: ["vue", "md"],
			// allow auto import and register components used in markdown
			include: [/\.vue$/, /\.vue\?vue/, /\.md$/],
			resolvers: [NaiveUiResolver()],
			dts: path.resolve(pathSrc, "components.d.ts"),
		}),
	],
	server: {
		proxy: {
			"/api": {
				changeOrigin: true,
				target: "http://localhost:3000",
			},
			"/dice/api": {
				changeOrigin: true,
				target: "http://localhost:3000",
			},
			"/admin/api": {
				changeOrigin: true,
				target: "http://localhost:3000",
			},
		},
	},
});
