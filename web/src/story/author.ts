import type { StoryArchive } from "./types";

export const AUTHOR_SIGNATURE_STORAGE_KEY = "lorana_tales_author_signature";

export function rememberAuthorSignature(value: unknown): string {
	const signature = String(value || "").trim().slice(0, 120);
	if (typeof localStorage !== "undefined" && typeof localStorage.setItem === "function") {
		if (signature) localStorage.setItem(AUTHOR_SIGNATURE_STORAGE_KEY, signature);
		else localStorage.removeItem(AUTHOR_SIGNATURE_STORAGE_KEY);
	}
	return signature;
}

export function storedAuthorSignature(): string {
	if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") return "";
	return String(localStorage.getItem(AUTHOR_SIGNATURE_STORAGE_KEY) || "").trim().slice(0, 120);
}

/** The signed export is a clone so saving never silently rewrites the open document. */
export function archiveForSignedExport(archive: StoryArchive, explicitSignature?: string): StoryArchive {
	const signature = String(explicitSignature ?? storedAuthorSignature()).trim().slice(0, 120);
	if (!signature || signature === archive.document.author) return archive;
	return { ...archive, document: { ...archive.document, author: signature } };
}

/** HTML is a publishing format, so always let the author confirm the visible byline. */
export function requestExportAuthor(current = ""): string | null {
	if (typeof window === "undefined") return String(current || "").trim().slice(0, 120);
	const value = window.prompt("请输入这份演出的作者署名：", storedAuthorSignature() || current || "");
	if (value === null) return null;
	return rememberAuthorSignature(value) || "未署名";
}
