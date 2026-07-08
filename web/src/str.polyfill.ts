/**
 * String.prototype.replaceAll() polyfill
 * https://gomakethings.com/how-to-replace-a-section-of-a-string-with-another-one-with-vanilla-js/
 * @author Chris Ferdinandi
 * @license MIT
 */
if (!String.prototype.replaceAll) {
	Object.defineProperty(String.prototype, "replaceAll", {
		value(this: string, str: string | RegExp, newStr: string) {
			// If a regex pattern
			if (
				Object.prototype.toString.call(str).toLowerCase() === "[object regexp]"
			) {
				return this.replace(str, newStr);
			}

			// If a string
			return this.replace(new RegExp(str, "g"), newStr);
		},
	});
}

if (!String.prototype.matchAll) {
	Object.defineProperty(String.prototype, "matchAll", {
		value(this: string, pattern: string | RegExp) {
			const rx = new RegExp(
				typeof pattern === "string" ? pattern : pattern.source,
				"g",
			);
			let cap = rx.exec(this);
			const all: RegExpExecArray[] = [];
			while (cap !== null) {
				all.push(cap);
				cap = rx.exec(this);
			}
			return all[Symbol.iterator]();
		},
	});
}
