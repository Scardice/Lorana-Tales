import type { CharItem, LogItem } from "../types";
import { LogImporter, type TextInfo } from "./_logImpoter";

type ScardiceLogData = {
	items: LogItem[];
	version: number;
};

function isScardiceLogData(value: unknown): value is ScardiceLogData {
	if (typeof value !== "object" || value === null) return false;
	const data = value as {
		readonly items?: unknown;
		readonly version?: unknown;
	};
	return Array.isArray(data.items) && typeof data.version === "number";
}

export class ScardiceLogImporter extends LogImporter {
	latestData: ScardiceLogData | undefined;

	get name() {
		return "余烬JSON格式";
	}

	check(text: string): boolean {
		let isTrpgLog = false;
		try {
			const scardiceFormat: unknown = JSON.parse(text);
			if (
				isScardiceLogData(scardiceFormat) &&
				scardiceFormat.items.length > 0
			) {
				const keys = Object.keys(scardiceFormat.items[0]);
				isTrpgLog = keys.includes("isDice") && keys.includes("message");
				this.latestData = scardiceFormat;
			}
		} catch (_e) {}

		return isTrpgLog;
	}

	parse(_text: string): TextInfo {
		// if (!this.latestData) this.check(text);
		const charInfo = new Map<string, CharItem>();
		const data = this.latestData;
		if (!data) return { items: [], charInfo, startText: "" };
		const startText = "";
		for (const i of data.items) {
			this.setCharInfo(charInfo, i);
			// 这个\r\n替换是为了防止logman因为新旧文本不同，导致重新格式化
			i.message = i.message.replaceAll("\r\n", "\n");
			i.message += "\n\n";
			i.version = data.version;
		}
		return { items: data.items, charInfo, startText, version: data.version };
	}
}
