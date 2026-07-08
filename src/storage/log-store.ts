import { strFromU8, unzlibSync } from "fflate";

export interface LogSize {
	storedBytes: number;
	encodedBytes: number;
	compressedBytes: number;
	decodedBytes: number;
}

export interface LogMetadata {
	key: string;
	viewUrl?: string;
	name: string;
	client: string;
	version: string;
	note: string;
	createdAt: string;
	updatedAt: string;
	uploaderIp: string;
	uniformId: string;
	messageCount: number;
	size: LogSize;
	decodeError: string;
}

export interface LogDetail extends LogMetadata {
	content: string;
}

export interface LogListOptions {
	page?: number;
	pageSize?: number;
	query?: string;
}

export interface LogListResult {
	items: LogMetadata[];
	page: number;
	pageSize: number;
	total: number;
	totalPages: number;
	query: string;
}

export interface DeleteLogsResult {
	requested: number;
	deleted: string[];
	missing: string[];
	errors: Array<{ key: string; error: string }>;
}

export interface CleanupLogsResult {
	deletedCount: number;
	processedCount: number;
	retentionDays: number;
	deleted: string[];
	errors: Array<{ key: string; error: string }>;
	logs: string[];
}

export interface LogMetrics {
	totalLogs: number;
	totalStoredBytes: number;
	totalDecodedBytes: number;
	oldestCreatedAt: string;
	newestCreatedAt: string;
	walEnabled: boolean;
	sqlitePageCount: number;
	sqlitePageSize: number;
}

export interface DatabaseMaintenanceResult {
	integrity: string;
	walCheckpoint: unknown;
	vacuumed: boolean;
}

export interface AddLogRecordInput {
	publicKey: string;
	password: string;
	uniformId: string;
	storedText: string;
}

export interface LogStore {
	addLogRecord(input: AddLogRecordInput): Promise<LogMetadata>;
	readPublicLog(publicKey: string, password: string): Promise<string | null>;
	listLogMetadata(options?: LogListOptions): Promise<LogListResult>;
	readLogDetail(publicKey: string): Promise<LogDetail | null>;
	readRawLog(publicKey: string): Promise<string | null>;
	deleteLogs(keys: string[]): Promise<DeleteLogsResult>;
	cleanupOldLogs(retentionDays: number): Promise<CleanupLogsResult>;
	getLogMetrics(): Promise<LogMetrics>;
	maintainDatabase(options?: {
		vacuum?: boolean;
	}): Promise<DatabaseMaintenanceResult>;
	close(): void;
}

function formatUnknown(value: unknown): string {
	if (value === undefined || value === null || value === "") return "unknown";
	return String(value);
}

function normalizeSize(value?: Partial<LogSize>): LogSize {
	return {
		storedBytes: Number(value?.storedBytes || 0),
		encodedBytes: Number(value?.encodedBytes || 0),
		compressedBytes: Number(value?.compressedBytes || 0),
		decodedBytes: Number(value?.decodedBytes || 0),
	};
}

export function normalizeMetadata(
	key: string,
	metadata: Partial<LogMetadata> = {},
): LogMetadata {
	return {
		key,
		viewUrl: metadata.viewUrl,
		name: formatUnknown(metadata.name || key),
		client: formatUnknown(metadata.client),
		version: String(metadata.version || ""),
		note: String(metadata.note || ""),
		createdAt: String(metadata.createdAt || ""),
		updatedAt: String(metadata.updatedAt || ""),
		uploaderIp: formatUnknown(metadata.uploaderIp),
		uniformId: String(metadata.uniformId || ""),
		messageCount: Number(metadata.messageCount || 0),
		size: normalizeSize(metadata.size),
		decodeError: String(metadata.decodeError || ""),
	};
}

function decodeStoredPayload(data: unknown) {
	if (typeof data !== "string" || data.length === 0) {
		return {
			encodedBytes: 0,
			compressedBytes: 0,
			decodedBytes: 0,
			decodedText: "",
			decodedJson: null,
			decodeError: "missing data",
		};
	}

	const compressed = Buffer.from(data, "base64");
	let decodedBytes = 0;
	let decodedText = "";
	let decodedJson = null;
	let decodeError = "";

	try {
		const inflated = unzlibSync(compressed);
		decodedBytes = inflated.byteLength;
		decodedText = strFromU8(inflated);
	} catch (error) {
		decodeError = error?.message || "unable to inflate data";
		try {
			decodedText = compressed.toString("utf-8");
			decodedBytes = compressed.byteLength;
		} catch {
			decodedText = "";
		}
	}

	if (decodedText) {
		try {
			decodedJson = JSON.parse(decodedText);
		} catch {
			// Some uploads may be plain text.
		}
	}

	return {
		encodedBytes: Buffer.byteLength(data, "utf-8"),
		compressedBytes: compressed.byteLength,
		decodedBytes,
		decodedText,
		decodedJson,
		decodeError,
	};
}

function isParquetPayload(client: unknown, version: unknown): boolean {
	return (
		String(client || "").toLowerCase() === "parquet" ||
		String(version) === "105"
	);
}

function summarizeParquetPayload(data: unknown) {
	if (typeof data !== "string" || data.length === 0) {
		return {
			encodedBytes: 0,
			compressedBytes: 0,
			decodedBytes: 0,
			decodedText: "",
			decodedJson: null,
			decodeError: "missing data",
		};
	}

	const bytes = Buffer.from(data, "base64");
	return {
		encodedBytes: Buffer.byteLength(data, "utf-8"),
		compressedBytes: bytes.byteLength,
		decodedBytes: bytes.byteLength,
		decodedText: `V1.5 Parquet 日志，${bytes.byteLength} bytes。公开链接会在染色器页面按 Parquet 格式解析。`,
		decodedJson: null,
		decodeError: "",
	};
}

function getMessageCount(decodedJson: unknown, decodedText: string): number {
	if (
		decodedJson &&
		Array.isArray((decodedJson as { items?: unknown[] }).items)
	) {
		return (decodedJson as { items: unknown[] }).items.length;
	}
	if (!decodedText) return 0;
	return decodedText.split(/\r?\n/).filter((line) => line.trim()).length;
}

function formatLogContent(decodedJson: unknown, decodedText: string): string {
	if (
		decodedJson &&
		Array.isArray((decodedJson as { items?: unknown[] }).items)
	) {
		return (decodedJson as { items: Array<Record<string, unknown>> }).items
			.map((item, index) => {
				const speaker = item.nickname || item.name || "unknown";
				const userId = item.IMUserId ? `(${item.IMUserId})` : "";
				const time = item.timeText ? ` ${item.timeText}` : "";
				const message = item.message || "";
				return `#${index + 1} ${speaker}${userId}${time}\n${message}`;
			})
			.join("\n\n");
	}
	return decodedText || "";
}

export function deriveLogRecord(
	key: string,
	storedText: string,
	uniformId = "",
) {
	let stored: Record<string, unknown>;

	try {
		stored = JSON.parse(storedText);
	} catch (error) {
		const storedBytes = Buffer.byteLength(storedText || "", "utf-8");
		return {
			metadata: normalizeMetadata(key, {
				name: "Invalid log record",
				client: "unknown",
				note: error?.message || "invalid JSON",
				uniformId,
				size: {
					storedBytes,
					encodedBytes: 0,
					compressedBytes: 0,
					decodedBytes: 0,
				},
				decodeError: "invalid stored JSON",
			}),
			content: storedText || "",
			decodedJson: null,
		};
	}

	const decoded = isParquetPayload(stored.client, stored.version)
		? summarizeParquetPayload(stored.data)
		: decodeStoredPayload(stored.data);
	const messageCount = getMessageCount(
		decoded.decodedJson,
		decoded.decodedText,
	);
	const content = formatLogContent(decoded.decodedJson, decoded.decodedText);
	const metadata = normalizeMetadata(key, {
		name: stored.name as string,
		client: stored.client as string,
		version: String(stored.version || ""),
		note: stored.note as string,
		createdAt: stored.created_at as string,
		updatedAt: stored.updated_at as string,
		uploaderIp: (stored.uploader_ip as string) || (stored.uploaderIp as string),
		uniformId,
		messageCount,
		size: {
			storedBytes: Buffer.byteLength(storedText || "", "utf-8"),
			encodedBytes: decoded.encodedBytes,
			compressedBytes: decoded.compressedBytes,
			decodedBytes: decoded.decodedBytes,
		},
		decodeError: decoded.decodeError,
	});

	return {
		metadata,
		content,
		decodedJson: decoded.decodedJson,
	};
}
