import { ref } from "vue";
import type { StoryEffectColor, StoryInteractionEffect, StoryInteractionReaction, StoryScreenEffect } from "~/story/types";

export type ScreenEffectPresetConfig = { screenEffect: StoryScreenEffect; color: StoryEffectColor; durationMs: number; speedPercent: number; repeat: number };
export type InteractionEffectPresetConfig = { interactionEffect: StoryInteractionEffect; reaction: StoryInteractionReaction; emoji: string };
export type EffectPresetConfig = ScreenEffectPresetConfig | InteractionEffectPresetConfig;
export type EffectPreset = { id: string; name: string; kind: "screen" | "interaction"; folderId: string; config: EffectPresetConfig; local?: boolean };
export type EffectPresetFolder = { id: string; name: string };

const presets = ref<EffectPreset[]>([]);
const folders = ref<EffectPresetFolder[]>([]); const presetLimit=ref(100);
const loaded = ref(false);
const STORAGE_KEY = "lorana.effect-presets";

function localPresets() {
	try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); return Array.isArray(value) ? value.map((item) => ({ ...item, kind: item.kind === "interaction" ? "interaction" : "screen", folderId: String(item.folderId || ""), local: true })) : []; }
	catch { return []; }
}
function saveLocal() { localStorage.setItem(STORAGE_KEY, JSON.stringify(presets.value.filter((item) => item.local))); }
function csrf() { return decodeURIComponent(document.cookie.split("; ").find((value) => value.startsWith("scardice_account_csrf="))?.split("=").slice(1).join("=") || ""); }

async function loadEffectPresets(force = false) {
	if (loaded.value && !force) return presets.value;
	const local = localPresets() as EffectPreset[];
	if (!csrf()) { presets.value = local; folders.value = []; loaded.value = true; return presets.value; }
	try {
		const response = await fetch("/api/account/effect-presets", { cache: "no-store", credentials: "same-origin" });
		if (response.ok) { const data=await response.json(); presets.value = [...data.items, ...local]; folders.value=data.folders||[];presetLimit.value=Number(data.limit||100); }
		else presets.value = local;
	} catch { presets.value = local; }
	loaded.value = true; return presets.value;
}

async function createEffectPreset(name: string, config: EffectPresetConfig, folderId="", kind: EffectPreset["kind"]="screen") {
	const headers: Record<string, string> = { "Content-Type": "application/json" }; const token = csrf(); if (token) headers["X-CSRF-Token"] = token;
	if (token) try {
		const response = await fetch("/api/account/effect-presets", { method: "POST", credentials: "same-origin", headers, body: JSON.stringify({ name,kind,folderId,config }) });
		if (response.ok) { const item = await response.json(); presets.value = [item, ...presets.value]; return item as EffectPreset; }
		if (response.status !== 401 && response.status !== 403) throw new Error(response.status === 413 ? "effect_preset_limit" : "preset_create_failed");
	} catch (error) { if (error instanceof Error && (error.message === "effect_preset_limit" || error.message === "preset_create_failed")) throw error; }
	if(presets.value.filter(item=>item.local).length>=presetLimit.value)throw new Error("effect_preset_limit");const item: EffectPreset = { id: crypto.randomUUID(), name: name.trim().slice(0, 60),kind,folderId,config, local: true }; presets.value = [item, ...presets.value]; saveLocal(); return item;
}

async function updateEffectPreset(item: EffectPreset, name: string, folderId=item.folderId) {
	if (item.local) { item.name = name.trim().slice(0, 60);item.folderId=folderId; presets.value = [...presets.value]; saveLocal(); return; }
	const headers: Record<string, string> = { "Content-Type": "application/json" }; const token = csrf(); if (token) headers["X-CSRF-Token"] = token;
	const response = await fetch(`/api/account/effect-presets/${encodeURIComponent(item.id)}`, { method: "PUT", credentials: "same-origin", headers, body: JSON.stringify({ name,kind:item.kind,folderId,config: item.config }) });
	if (!response.ok) throw new Error("preset_update_failed"); Object.assign(item, await response.json()); presets.value = [...presets.value];
}

async function deleteEffectPreset(item: EffectPreset) {
	if (!item.local) { const headers: Record<string, string> = {}; const token = csrf(); if (token) headers["X-CSRF-Token"] = token; const response = await fetch(`/api/account/effect-presets/${encodeURIComponent(item.id)}`, { method: "DELETE", credentials: "same-origin", headers }); if (!response.ok) throw new Error("preset_delete_failed"); }
	presets.value = presets.value.filter((entry) => entry.id !== item.id); saveLocal();
}

async function createEffectFolder(name:string){const headers:Record<string,string>={"Content-Type":"application/json"};const token=csrf();if(token)headers["X-CSRF-Token"]=token;const response=await fetch("/api/account/effect-folders",{method:"POST",credentials:"same-origin",headers,body:JSON.stringify({name})});if(!response.ok)throw new Error("folder_create_failed");const folder=await response.json();folders.value=[folder,...folders.value];return folder;}
async function renameEffectFolder(folder:EffectPresetFolder,name:string){const headers:Record<string,string>={"Content-Type":"application/json"};const token=csrf();if(token)headers["X-CSRF-Token"]=token;const response=await fetch(`/api/account/effect-folders/${encodeURIComponent(folder.id)}`,{method:"PUT",credentials:"same-origin",headers,body:JSON.stringify({name})});if(!response.ok)throw new Error("folder_update_failed");folder.name=name;folders.value=[...folders.value];}
async function deleteEffectFolder(folder:EffectPresetFolder){const headers:Record<string,string>={};const token=csrf();if(token)headers["X-CSRF-Token"]=token;const response=await fetch(`/api/account/effect-folders/${encodeURIComponent(folder.id)}`,{method:"DELETE",credentials:"same-origin",headers});if(!response.ok)throw new Error("folder_delete_failed");folders.value=folders.value.filter(item=>item.id!==folder.id);presets.value=presets.value.map(item=>item.folderId===folder.id?{...item,folderId:""}:item);}
async function shareEffectPreset(item:EffectPreset){if(item.local)throw new Error("login_required");const headers:Record<string,string>={};const token=csrf();if(token)headers["X-CSRF-Token"]=token;const response=await fetch(`/api/account/effect-presets/${encodeURIComponent(item.id)}/share`,{method:"POST",credentials:"same-origin",headers});if(!response.ok)throw new Error("share_failed");return(await response.json()).code as string;}
async function importEffectPreset(code:string){const headers:Record<string,string>={"Content-Type":"application/json"};const token=csrf();if(token)headers["X-CSRF-Token"]=token;const response=await fetch("/api/account/effect-presets/import",{method:"POST",credentials:"same-origin",headers,body:JSON.stringify({code})});if(!response.ok)throw new Error(response.status===404?"effect_share_not_found":"import_failed");const item=await response.json();presets.value=[item,...presets.value];await loadEffectPresets(true);return item;}

export function useEffectPresets() { return { presets,folders,presetLimit,loadEffectPresets,createEffectPreset,updateEffectPreset,deleteEffectPreset,createEffectFolder,renameEffectFolder,deleteEffectFolder,shareEffectPreset,importEffectPreset }; }
