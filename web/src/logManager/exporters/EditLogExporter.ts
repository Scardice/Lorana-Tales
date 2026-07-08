import dayjs from "dayjs";
import type { LogItem } from "../types";
import { LogExporter, type LogExportInfo } from "./logExporter";

// 编辑页面
export class EditLogExporter extends LogExporter {
	doExport(items: LogItem[], indexOffset = 0): LogExportInfo | undefined {
		let textAll = "";
		let index = 0 + indexOffset;
		const indexInfoList = [];

		for (const i of items) {
			let text = "";
			if (i.isRaw) {
				const indexStart = index;
				const indexContent = index;
				const indexEnd = index + i.message.length;
				text += i.message;
				index = indexEnd;
				const indexInfo = { indexStart, indexContent, indexEnd, item: i };
				indexInfoList.push(indexInfo);
				textAll += text;
				continue;
			}

			const idSuffix = "";
			if (i.isDice) {
				// 与其匹配的机制暂时移除了，因此先屏蔽
				// idSuffix = ` #${i.id}`
			}

			const indexStart = index;
			const timeText = i.timeText
				? i.timeText
				: dayjs.unix(i.time).format("YYYY/MM/DD HH:mm:ss");
			let imuid = "";
			if (i.IMUserId) {
				imuid = `(${i.IMUserId})`;
			}

			text += `${i.nickname}${imuid} ${timeText}${idSuffix}\n`;
			index = indexOffset + textAll.length + text.length;
			const indexContent = index;
			text += `${i.message}`;
			index = indexOffset + textAll.length + text.length;
			const indexEnd = index;

			const indexInfo = { indexStart, indexContent, indexEnd, item: i };
			indexInfoList.push(indexInfo);
			textAll += text;
		}

		return { text: textAll, indexInfoList };
	}
}
