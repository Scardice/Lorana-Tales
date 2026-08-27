import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.env.SCARDICE_CONFIG = resolve("tests/e2e/config.toml");
await import(pathToFileURL(resolve("dist/bin/scardice-story-painter.js")).href);
