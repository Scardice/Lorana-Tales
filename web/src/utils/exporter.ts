import { Buffer } from "buffer";
import dayjs from "dayjs";
import { saveAs } from "file-saver";
import type { LogItem } from "~/logManager/types";
import { useStore } from "~/store";

type TextExportOptions = {
	readonly yearHide?: boolean;
	readonly timeHide?: boolean;
	readonly userIdHide?: boolean;
};

const DOCX_MIME =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// TODO: 移植到logMan/exporters
export function exportFileQQ(
	results: LogItem[],
	options: TextExportOptions = {},
) {
	const store = useStore();

	let text = "";
	for (const i of results) {
		if (i.isRaw) continue;
		if (store.isHiddenLogItem(i)) continue;

		let timeText = i.time.toString();
		if (typeof i.time === "number") {
			timeText = dayjs
				.unix(i.time)
				.format(options.yearHide ? "HH:mm:ss" : "YYYY/MM/DD HH:mm:ss");
		}
		if (options.timeHide) {
			timeText = "";
		}
		let userid = `(${i.IMUserId})`;
		if (options.userIdHide) {
			userid = "";
		}
		text += `${i.nickname}${userid} ${timeText}\n${i.message.replaceAll("<br />", "\n")}`;
	}

	saveAs(
		new Blob([text], { type: "text/plain;charset=utf-8" }),
		"跑团记录(QQ风格).txt",
	);
	return text;
}

export function exportFileIRC(
	results: LogItem[],
	options: TextExportOptions = {},
) {
	const store = useStore();

	let text = "";
	for (const i of results) {
		if (i.isRaw) continue;
		if (store.isHiddenLogItem(i)) continue;

		let timeText = i.time.toString();
		if (typeof i.time === "number") {
			timeText = dayjs
				.unix(i.time)
				.format(options.yearHide ? "HH:mm:ss" : "YYYY/MM/DD HH:mm:ss");
		}
		if (options.timeHide) {
			timeText = "";
		}
		let userid = `(${i.IMUserId})`;
		if (options.userIdHide) {
			userid = "";
		}
		text += `${timeText}<${i.nickname}${userid}>:${i.message.replaceAll("<br />", "\n")}`;
	}

	saveAs(
		new Blob([text], { type: "text/plain;charset=utf-8" }),
		"跑团记录(主流风格).txt",
	);
	return text;
}

export function exportFileRaw(doc: string) {
	saveAs(
		new Blob([doc], { type: "text/plain;charset=utf-8" }),
		"跑团记录(未处理).txt",
	);
}

function createDocumentHtml(content: string) {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>
    body { color: #17202a; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 11pt; line-height: 1.6; }
    p, div { margin: 0 0 6pt; }
    table { border-collapse: collapse; width: 100%; }
    td { padding: 4pt 6pt; vertical-align: top; }
    img { height: auto; max-width: 360pt; }
  </style>
</head>
<body>${content}</body>
</html>`;
}

function toDocxBlob(output: ArrayBuffer | Blob | Uint8Array) {
	if (output instanceof Blob) {
		return output;
	}
	return new Blob([output], { type: DOCX_MIME });
}

function installDocxBrowserGlobals() {
	const browserGlobal = globalThis as typeof globalThis & {
		Buffer?: typeof Buffer;
	};
	if (!browserGlobal.Buffer) {
		browserGlobal.Buffer = Buffer;
	}
}

function canvasPngDataUrl(canvas: HTMLCanvasElement): string {
	return canvas.toDataURL("image/png");
}

async function normalizeEmbeddedImage(source: string): Promise<string> {
	if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(source)) return source;
	const image = new Image();
	image.decoding = "sync";
	image.src = source.replaceAll(/\s+/g, "");
	await image.decode();
	const width = Math.max(1, image.naturalWidth);
	const height = Math.max(1, image.naturalHeight);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) return source;
	context.imageSmoothingEnabled = false;
	context.globalCompositeOperation = "copy";
	context.drawImage(image, 0, 0, width, height);
	const pixels = context.getImageData(0, 0, width, height);
	const [red, green, blue, alpha] = pixels.data;
	let solid = true;
	for (let index = 4; index < pixels.data.length; index += 4) {
		if (pixels.data[index] !== red || pixels.data[index + 1] !== green || pixels.data[index + 2] !== blue || pixels.data[index + 3] !== alpha) {
			solid = false;
			break;
		}
	}
	if (solid) {
		context.clearRect(0, 0, width, height);
		context.fillStyle = `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
		context.fillRect(0, 0, width, height);
	}
	return canvasPngDataUrl(canvas);
}

export async function normalizeDocxEmbeddedImages(html: string): Promise<string> {
	const template = document.createElement("template");
	template.innerHTML = html;
	for (const image of Array.from(template.content.querySelectorAll("img"))) {
		const source = image.getAttribute("src") || "";
		try {
			image.setAttribute("src", await normalizeEmbeddedImage(source));
		} catch (error) {
			console.warn("DOCX embedded image normalization skipped", error);
		}
	}
	return template.innerHTML;
}

/**
 * Generate a real Office Open XML package from the rendered preview.
 * The upstream converter embeds data URL images into word/media instead of
 * relying on Word's non-standard MHT/HTML compatibility path.
 */
export async function exportFileDocx(html: string, filename: string) {
	installDocxBrowserGlobals();
	const normalizedHtml = await normalizeDocxEmbeddedImages(html);
	const { default: HTMLtoDOCX } = await import("@turbodocx/html-to-docx");
	const output = await HTMLtoDOCX(createDocumentHtml(normalizedHtml), null, {
		creator: "Scardice Story Painter",
		description: "余烬 TRPG 跑团记录",
		font: "Microsoft YaHei",
		fontSize: 22,
		lang: "zh-CN",
		margins: { top: 720, right: 720, bottom: 720, left: 720 },
		table: {
			row: { cantSplit: true },
			borderOptions: { size: 1, color: "B8C1CC" },
		},
		imageProcessing: {
			downloadTimeout: 8000,
			maxRetries: 2,
			maxImageSize: 10 * 1024 * 1024,
			svgHandling: "native",
			suppressSharpWarning: true,
		},
	});

	const blob = toDocxBlob(output);
	saveAs(blob, filename);
	return blob;
}
