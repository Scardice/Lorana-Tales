const toast = document.querySelector<HTMLElement>(".toast");
let timer: ReturnType<typeof setTimeout> | undefined;

function showToast(): void {
	if (!toast) return;
	if (timer) clearTimeout(timer);
	toast.classList.add("show");
	timer = setTimeout(() => toast.classList.remove("show"), 1200);
}

async function copyText(text: string): Promise<void> {
	if (navigator.clipboard) {
		await navigator.clipboard.writeText(text);
	} else {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		document.body.appendChild(textarea);
		textarea.select();
		document.execCommand("copy");
		textarea.remove();
	}
	showToast();
}

document.addEventListener("click", (event) => {
	const target = event.target instanceof Element ? event.target : null;
	const button = target?.closest<HTMLElement>("[data-copy]");
	if (!button) return;
	const text = button.getAttribute("data-copy");
	if (text) copyText(text).catch(() => {});
});
