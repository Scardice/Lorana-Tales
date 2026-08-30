const path = require("node:path");

module.exports = {
	apps: [
		{
			name: "LoranaTales",
			cwd: __dirname,
			script: path.join(__dirname, "scripts/rolling-launcher.mjs"),
			instances: 1,
			exec_mode: "fork",
			autorestart: true,
			watch: false,
			min_uptime: "10s",
			restart_delay: 3000,
			kill_timeout: 10000,
			env: {
				NODE_ENV: "production",
				SCARDICE_CONFIG: path.join(__dirname, "config.toml"),
				LORANA_UPDATE_WORKER: "0",
				LORANA_INTERNAL_PORT: "",
			},
		},
	],
};
