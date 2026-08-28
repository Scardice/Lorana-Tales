import { inflateSync } from "node:zlib";

export class InflateLimitError extends Error {
	constructor(maxOutputBytes: number) {
		super(`inflated payload exceeds ${maxOutputBytes} byte limit`);
		this.name = "InflateLimitError";
	}
}

export function inflateTextBounded(
	compressed: Uint8Array,
	maxOutputBytes: number,
): { bytes: Buffer; text: string } {
	try {
		const bytes = inflateSync(Buffer.from(compressed), {
			maxOutputLength: maxOutputBytes,
		});
		return { bytes, text: bytes.toString("utf-8") };
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error
			? String(error.code)
			: "";
		if (
			code === "ERR_BUFFER_TOO_LARGE" ||
			(error instanceof Error &&
				(error.message.includes("Cannot create a Buffer larger than") ||
				error.message.includes("larger than maxOutputLength") ||
				error.message.includes("ERR_BUFFER_TOO_LARGE")))
		) {
			throw new InflateLimitError(maxOutputBytes);
		}
		throw error;
	}
}
