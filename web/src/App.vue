<script setup lang="ts">
import { darkTheme, lightTheme } from "naive-ui";
import Main from "./Main.vue";
import { useThemeDark } from "./composables/useTheme";

const isDark = useThemeDark();
</script>

<template>
  <n-config-provider :theme="isDark ? darkTheme : lightTheme">
    <n-message-provider>
      <n-modal-provider>
        <n-notification-provider>
          <Main />
        </n-notification-provider>
      </n-modal-provider>
    </n-message-provider>
  </n-config-provider>
</template>
