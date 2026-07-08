import type { Config } from "tailwindcss";

export default {
	content: ["./web/index.html", "./web/src/**/*.{html,js,ts,vue}"],
	darkMode: "class",
	theme: {
		extend: {},
	},
	plugins: [],
} satisfies Config;
