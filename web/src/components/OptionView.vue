<script setup lang="ts">
import { Help } from "@vicons/carbon";
import { ref } from "vue";
import { useStore } from "~/store";

const option_store = useStore().exportOptions;

interface ExportOption {
	label: string;
	desc: string;
	key: keyof typeof option_store;
}

const filterOptions: ExportOption[] = [
	{
		label: "骰子指令过滤",
		desc: "开启后，不显示pc指令，正常显示指令结果",
		key: "commandHide",
	},
	{
		label: "表情图片过滤",
		desc: "开启后，文本内所有的表情包和图片将被豹豹藏起来不显示",
		key: "imageHide",
	},
	{
		label: "场外发言过滤",
		desc: "开启后，所有以(和（为开头的发言将被豹豹吃掉不显示",
		key: "offTopicHide",
	},
	{
		label: "时间显示过滤",
		desc: "开启后，日期和时间会被豹豹丢入海里不显示",
		key: "timeHide",
	},
];

const formatOptions: ExportOption[] = [
	{
		label: "平台帐号隐藏",
		desc: "开启后，IM 平台账号（如 QQ 号）将在导出结果中不显示",
		key: "userIdHide",
	},
	{
		label: "年月日不展示",
		desc: "开启后，导出结果的日期将只显示几点几分(如果可能)",
		key: "yearHide",
	},
	{
		label: "首行缩进对齐",
		desc: "开启后，缩进将以名字为基准进行对齐",
		key: "textIndentAll",
	},
];

type HelpKey = keyof typeof option_store;

const helpVisible = ref<Partial<Record<HelpKey, boolean>>>({});

const showHelp = (key: HelpKey) => {
	helpVisible.value[key] = true;
};

const hideHelp = (key: HelpKey) => {
	helpVisible.value[key] = false;
};

const toggleHelp = (key: HelpKey) => {
	helpVisible.value[key] = !helpVisible.value[key];
};
</script>

<template>
  <section class="option-shell" aria-label="导出选项">
    <article class="option-card">
      <div class="option-card__header">
        <div>
          <p class="option-card__eyebrow">内容过滤</p>
          <h2>精简记录内容</h2>
        </div>
      </div>
      <div class="option-card__grid">
        <div v-for="opt in filterOptions" :key="opt.key" class="option-item">
          <div class="option-item__label">
            <n-switch v-model:value="option_store[opt.key]" />
            <strong>{{ opt.label }}</strong>
            <n-tooltip
              trigger="manual"
              placement="top"
              :show="helpVisible[opt.key]"
            >
              <template #trigger>
                <n-button
                  quaternary
                  circle
                  size="tiny"
                  class="option-item__help"
                  :aria-label="`${opt.label}说明`"
                  @mouseenter="showHelp(opt.key)"
                  @mouseleave="hideHelp(opt.key)"
                  @focus="showHelp(opt.key)"
                  @blur="hideHelp(opt.key)"
                  @click.stop="toggleHelp(opt.key)"
                >
                  <template #icon>
                    <n-icon :component="Help" />
                  </template>
                </n-button>
              </template>
              {{ opt.desc }}
            </n-tooltip>
          </div>
        </div>
      </div>
    </article>

    <article class="option-card">
      <div class="option-card__header">
        <div>
          <p class="option-card__eyebrow">输出展示</p>
          <h2>控制导出外观</h2>
        </div>
      </div>
      <div class="option-card__grid">
        <div v-for="opt in formatOptions" :key="opt.key" class="option-item">
          <div class="option-item__label">
            <n-switch v-model:value="option_store[opt.key]" />
            <strong>{{ opt.label }}</strong>
            <n-tooltip
              trigger="manual"
              placement="top"
              :show="helpVisible[opt.key]"
            >
              <template #trigger>
                <n-button
                  quaternary
                  circle
                  size="tiny"
                  class="option-item__help"
                  :aria-label="`${opt.label}说明`"
                  @mouseenter="showHelp(opt.key)"
                  @mouseleave="hideHelp(opt.key)"
                  @focus="showHelp(opt.key)"
                  @blur="hideHelp(opt.key)"
                  @click.stop="toggleHelp(opt.key)"
                >
                  <template #icon>
                    <n-icon :component="Help" />
                  </template>
                </n-button>
              </template>
              {{ opt.desc }}
            </n-tooltip>
          </div>
        </div>

      </div>
    </article>
  </section>
</template>

<style scoped lang="scss">
.option-shell {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
  padding: 1rem 0 1.25rem;
}

.option-card {
  border: 1px solid var(--home-line, #334155);
  border-left: 4px solid var(--home-blue, #38bdf8);
  border-radius: 0;
  background: var(--home-panel, #0f172a);
  color: var(--home-ink, #f8fafc);
  padding: 0;
  box-shadow: var(--home-shadow, none);
}

.option-card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  border-bottom: 1px solid var(--home-line, #334155);
  margin: 0;
  padding: 0.75rem 0.875rem;
}

.option-card__eyebrow {
  margin: 0 0 0.15rem;
  color: var(--home-blue, #93c5fd);
  font-size: 0.75rem;
  letter-spacing: 0;
}

.option-card h2 {
  margin: 0;
  font-size: 1rem;
  line-height: 1.35;
}

.option-card__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0;
}

.option-item {
  min-width: 0;
  border-right: 1px solid var(--home-line, #1e293b);
  border-bottom: 1px solid var(--home-line, #1e293b);
  border-radius: 0;
  background: color-mix(in srgb, var(--home-panel-solid, #111827) 78%, transparent);
  padding: 0.625rem 0.75rem;
}

.option-item:nth-child(2n) {
  border-right: 0;
}

.option-item__label {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem;
}

.option-item__label strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.875rem;
}

.option-item__help {
  color: #bfdbfe;
}

@media (max-width: 760px) {
  .option-shell,
  .option-card__grid {
    grid-template-columns: 1fr;
  }

  .option-shell {
    padding-inline: 0.75rem;
  }

  .option-item {
    border-right: 0;
  }
}
</style>
