import type { CharItem, LogItem } from "../types";
import { LogImporter, type TextInfo } from "./_logImpoter";

type OlivaDiceLogEntry = {
  readonly time: number | string;
  readonly type: string;
  readonly deleted: boolean;
  readonly sender: {
    readonly id: number | string;
    readonly name: string;
  };
  readonly message: string;
};

type OlivaDiceParsedLine =
  | { readonly kind: "entry"; readonly entry: OlivaDiceLogEntry }
  | { readonly kind: "skip" }
  | { readonly kind: "invalid" };

const logTotalDurationType = "log_total_duration";
const timestampMillisecondsThreshold = 100_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function parseOlivaDiceLine(line: string): OlivaDiceParsedLine {
  const parsed = parseJsonLine(line);
  if (!isRecord(parsed)) return { kind: "invalid" };

  if (parsed.type === logTotalDurationType || parsed.deleted === true) {
    return { kind: "skip" };
  }

  const sender = parsed.sender;
  if (!isRecord(sender)) return { kind: "invalid" };

  const time = parsed.time;
  const senderId = sender.id;
  const senderName = sender.name;
  const message = parsed.message;
  const type = parsed.type;

  if (typeof time !== "number" && typeof time !== "string") {
    return { kind: "invalid" };
  }
  if (typeof senderId !== "number" && typeof senderId !== "string") {
    return { kind: "invalid" };
  }
  if (
    typeof senderName !== "string" ||
    typeof message !== "string" ||
    typeof type !== "string"
  ) {
    return { kind: "invalid" };
  }

  return {
    kind: "entry",
    entry: {
      time,
      type,
      deleted: false,
      sender: {
        id: senderId,
        name: senderName,
      },
      message,
    },
  };
}

export class OlivaDiceLogImporter extends LogImporter {
  latestEntries: OlivaDiceLogEntry[] = [];

  check(text: string): boolean {
    const entries = this.parseEntries(text);
    this.latestEntries = entries;
    return entries.length > 0;
  }

  get name() {
    return "青果骰JSONL格式";
  }

  parse(text: string): TextInfo {
    const entries =
      this.latestEntries.length > 0
        ? this.latestEntries
        : this.parseEntries(text);
    const charInfo = new Map<string, CharItem>();
    const items = [] as LogItem[];

    for (const entry of entries) {
      const item = {} as LogItem;
      item.nickname = entry.sender.name;
      item.IMUserId = String(entry.sender.id);
      const numericTime =
        typeof entry.time === "number"
          ? entry.time
          : /^\d+$/.test(entry.time)
            ? Number(entry.time)
            : Number.NaN;
      if (Number.isFinite(numericTime)) {
        item.time =
          numericTime > timestampMillisecondsThreshold
            ? Math.floor(numericTime / 1000)
            : numericTime;
      } else {
        [item.time, item.timeText] = this.parseTime(String(entry.time));
      }
      item.message = `${entry.message}\n\n`;
      this.setCharInfo(charInfo, item);
      items.push(item);
    }

    return { items, charInfo, startText: "", exporter: "olivaDice" };
  }

  private parseEntries(text: string): OlivaDiceLogEntry[] {
    const entries: OlivaDiceLogEntry[] = [];

    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;

      const parsed = parseOlivaDiceLine(line);
      switch (parsed.kind) {
        case "entry":
          entries.push(parsed.entry);
          break;
        case "skip":
        case "invalid":
          break;
      }
    }

    return entries;
  }
}
