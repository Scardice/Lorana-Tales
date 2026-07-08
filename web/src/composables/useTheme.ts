import { useDark } from "@vueuse/core";

export function useThemeDark() {
  return useDark({
    disableTransition: false,
    initialValue: "auto",
  });
}
