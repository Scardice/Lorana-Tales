/// <reference types="vite/client" />

declare module "*.vue" {
	import type { DefineComponent } from "vue";
	// biome-ignore lint: Vue's SFC shim relies on this standard generic shape for template instance inference.
	const component: DefineComponent<{}, {}, any>;
	export default component;
}

declare module "vue3-virtual-scroll-list" {
	import type { DefineComponent } from "vue";

	type VirtualListProps = {
		dataKey: string;
		dataSources: unknown[];
		dataComponent: unknown;
		estimateSize?: number;
		itemClass?: string;
	};

	const VirtualList: DefineComponent<VirtualListProps>;
	export default VirtualList;
}
