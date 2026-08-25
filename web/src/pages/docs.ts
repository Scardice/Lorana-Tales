import { STORY_SCRIPT_HELP } from "../story/raw-script";

const content = document.querySelector<HTMLElement>(".content");
const title = document.querySelector<HTMLElement>("[data-title]");
const subtitle = document.querySelector<HTMLElement>("[data-subtitle]");
const apiLink = document.querySelector<HTMLElement>("[data-api-link]");
const apiContent = document.querySelector<HTMLElement>("[data-api-content]");
const languageContent = document.querySelector<HTMLElement>("[data-language-content]");
const cards = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-section]"));

function openSection(section: "api" | "language", updateHash = true) {
	if (!content || !title || !subtitle || !apiLink || !apiContent || !languageContent) return;
	content.hidden = false;
	const language = section === "language";
	title.textContent = language ? "Lorana Tales Story Language" : "服务端 API";
	subtitle.textContent = language ? "可直接编辑、实时校验的故事与演出语法" : "日志、账户、工程与资源接口";
	apiLink.hidden = language;
	apiContent.hidden = language;
	languageContent.hidden = !language;
	if (language) languageContent.textContent = STORY_SCRIPT_HELP;
	for (const card of cards) card.classList.toggle("active", card.dataset.section === section);
	if (updateHash) history.replaceState(null, "", `#${section}`);
	content.scrollIntoView({ behavior: "smooth", block: "start" });
}

for (const card of cards) card.addEventListener("click", () => openSection(card.dataset.section === "language" ? "language" : "api"));
if (location.hash === "#api" || location.hash === "#language") openSection(location.hash.slice(1) as "api" | "language", false);
