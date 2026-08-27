import { computed, ref, watch } from "vue";

export type ThemeMode = "auto" | "light" | "dark";

const stored = typeof localStorage === "undefined" ? "auto" : localStorage.getItem("lorana.theme");
const themeMode = ref<ThemeMode>(stored === "light" || stored === "dark" ? stored : "auto");
const systemDark = ref(typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches);

if (typeof matchMedia !== "undefined") {
	const query = matchMedia("(prefers-color-scheme: dark)");
	query.addEventListener("change", (event) => { systemDark.value = event.matches; });
}

const themeDark = computed(() => themeMode.value === "auto" ? systemDark.value : themeMode.value === "dark");

watch([themeMode, themeDark], ([mode, dark]) => {
	if (typeof document === "undefined") return;
	document.documentElement.classList.toggle("dark", dark);
	document.documentElement.style.colorScheme = dark ? "dark" : "light";
	if (mode === "auto") localStorage.removeItem("lorana.theme");
	else localStorage.setItem("lorana.theme", mode);
}, { immediate: true });

export function useThemeDark() { return themeDark; }
export function useThemeMode() { return themeMode; }

export const themeModeOptions: Array<{ label: string; value: ThemeMode }> = [
	{ label: "跟随系统", value: "auto" },
	{ label: "浅色", value: "light" },
	{ label: "深色", value: "dark" },
];
