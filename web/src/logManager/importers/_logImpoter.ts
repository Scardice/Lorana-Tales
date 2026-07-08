import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import type { LogManager } from "../logManager";
import { type CharItem, type LogItem, packNameId } from "../types";

dayjs.extend(customParseFormat);

export interface TextInfo {
	items: LogItem[];
	charInfo: Map<string, CharItem>;
	// nicknames: Map<string, string>;
	startText: string;
	exporter?: string;
	version?: number;
}

export class LogImporter {
	parent: LogManager;
	tmpIMUserId = new Map<string, string>();

	get name() {
		return "未知格式";
	}

	constructor(man: LogManager) {
		this.parent = man;
	}

	getAutoIMUserId(start: number, name: string) {
		// 解释一下这里的古怪，因为2.1版本遇到过一次:
		// 传入的两个参数，store.pcList.length, item.nickname
		// 前者一般为0，因为这个时候还没有角色
		// 后者必须先赋值，如果没经过赋值，传进来都是undefined，就会统一得到1001
		let data = this.tmpIMUserId.get(name);
		if (!data) {
			data = `${1001 + start + this.tmpIMUserId.size}`;
			this.tmpIMUserId.set(name, data);
		}
		return data;
	}

	setCharInfo(charInfo: Map<string, CharItem>, item: LogItem) {
		return setCharInfo(charInfo, item);
	}

	parseTime(arg0: string): [number, string | undefined] {
		const t = dayjs(arg0).unix();
		if (Number.isNaN(t)) {
			return [0, arg0];
		} else {
			return [t, undefined];
		}
	}

	check(_text: string): boolean {
		return false;
	}
	parse(_text: string): TextInfo {
		return { items: [], charInfo: new Map<string, CharItem>(), startText: "" };
	}
}

const charRoles = ["主持人", "角色", "骰子", "隐藏"] as const;

function isCharRole(role: string | undefined): role is CharItem["role"] {
	return charRoles.includes(role as CharItem["role"]);
}

export function setCharInfo(charInfo: Map<string, CharItem>, item: LogItem) {
	const id = packNameId(item);
	if (!charInfo.get(id)) {
		let role: CharItem["role"];
		if (isCharRole(item.role)) {
			role = item.role;
		} else {
			role = "角色";
			if (item.nickname.toLowerCase().startsWith("ob")) {
				role = "隐藏";
			}
			if (item.isDice) {
				role = "骰子";
			}
		}

		charInfo.set(id, {
			name: item.nickname,
			IMUserId: item.IMUserId,
			role,
			color: "",
		});
	}
}
