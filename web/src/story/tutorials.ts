import { defaultStorySettings, STORY_SCHEMA_VERSION } from "./types";
import type { StoryArchive, StoryCharacter, StoryMessage, StoryMessagePerformance } from "./types";

export type TutorialCategoryId = "start" | "edit" | "performance" | "effects";

export interface StoryTutorial {
  id: string;
  category: TutorialCategoryId;
  title: string;
  summary: string;
  duration: string;
  level: "入门" | "进阶";
  points: string[];
  challenge: string;
  archive: StoryArchive;
}

export const tutorialCategories: Array<{ id: TutorialCategoryId; title: string; description: string }> = [
  { id: "start", title: "从零开始", description: "认识界面、创建角色，写下第一幕。" },
  { id: "edit", title: "编辑故事", description: "修改、引用、插入与批量整理。" },
  { id: "performance", title: "演出编排", description: "把静态记录变成有节奏的演出。" },
  { id: "effects", title: "特效舞台", description: "文字、屏幕、互动与持续效果。" },
];

const avatarSvg = (face: string, background: string, foreground = "#ffffff") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="36" fill="${background}"/><circle cx="64" cy="58" r="37" fill="${foreground}" opacity=".16"/><text x="64" y="77" text-anchor="middle" font-family="system-ui,sans-serif" font-size="48">${face}</text></svg>`;

const tutorialAvatarSources = {
  "tutorial-guide.svg": avatarSvg("🌸", "#326d5a"),
  "tutorial-lora.svg": avatarSvg("洛", "#245c67"),
  "tutorial-nia.svg": avatarSvg("诺", "#7a4058"),
};
const tutorialAvatarAssets = () => new Map(Object.entries(tutorialAvatarSources).map(([id, source]) => [id, new TextEncoder().encode(source)]));

const characters: StoryCharacter[] = [
  { id: "guide", name: "花花向导", imUserId: "", position: "narrator", color: "#72d6a2", paletteId: "forest", bubblePaletteId: "forest", avatar: { id: "tutorial-guide.svg", mime: "image/svg+xml", name: "花花向导头像.svg" }, avatarSource: "package", narratorAvatar: true, isNarrator: false, isDice: false, hidden: false },
  { id: "lora", name: "洛拉", imUserId: "", position: "left", color: "#6dd4d4", paletteId: "ocean", bubblePaletteId: "ocean", avatar: { id: "tutorial-lora.svg", mime: "image/svg+xml", name: "洛拉头像.svg" }, avatarSource: "package", narratorAvatar: false, isNarrator: false, isDice: false, hidden: false },
  { id: "nia", name: "诺娅", imUserId: "", position: "right", color: "#ee91ad", paletteId: "rose", bubblePaletteId: "rose", avatar: { id: "tutorial-nia.svg", mime: "image/svg+xml", name: "诺娅头像.svg" }, avatarSource: "package", narratorAvatar: false, isNarrator: false, isDice: false, hidden: false },
  { id: "narrator", name: "旁白", imUserId: "", position: "narrator", color: "#b9c3c1", paletteId: "neutral", bubblePaletteId: "neutral", narratorAvatar: false, isNarrator: true, isDice: false, hidden: false },
];

type Line = [characterId: string, text: string, performance?: StoryMessagePerformance];

function tutorialArchive(id: string, title: string, lines: Line[]): StoryArchive {
  const now = "2026-08-28T00:00:00.000Z";
  const messages: StoryMessage[] = lines.map(([characterId, text, performance], index) => ({
    id: `${id}-message-${index + 1}`,
    characterId,
    kind: "text",
    text,
    time: index * 1000,
    locallyInserted: true,
    ...(performance ? { performance } : {}),
  }));
  return {
    assets: tutorialAvatarAssets(),
    document: {
      format: "lorana-tales-document",
      schemaVersion: STORY_SCHEMA_VERSION,
      id: `tutorial-${id}`,
      title,
      author: "Lorana Tales 学院",
      createdAt: now,
      updatedAt: now,
      characters: structuredClone(characters),
      messages,
      effectTracks: [],
      characterStateEvents: [],
      settings: {
        ...defaultStorySettings(),
        showQqInEditor: false,
        showQqInPreview: false,
        showNarratorAvatar: true,
        showNarratorNames: true,
        autoplay: true,
        streamEnabled: true,
        streamTokensPerSecond: 16,
        streamPauseMinMs: 15,
        streamPauseMaxMs: 80,
        typingIndicatorEnabled: id === "record",
        typingIndicatorText: "正在演示输入提示",
        typingIndicatorMs: id === "record" ? 650 : 0,
        fixedDelayMs: 750,
      },
      source: { kind: "none", name: "Lorana Tales 内置教程" },
    },
  };
}

const lesson = (meta: Omit<StoryTutorial, "archive">, lines: Line[]): StoryTutorial => ({
  ...meta,
  archive: tutorialArchive(meta.id, meta.title, lines),
});

export const storyTutorials: StoryTutorial[] = [
  lesson({ id: "welcome", category: "start", title: "一分钟认识编辑器", summary: "从标题、画布一路走到输入框与角色栏。", duration: "约 1 分钟", level: "入门", points: ["顶栏", "画布", "输入区"], challenge: "返回编辑器，依次指出标题、消息画布、输入框和角色栏。" }, [
    ["guide", "欢迎来到 Lorana Tales！这里不是说明书坟场，而是一场可以点着看的小演出。", { tokenAnimation: "rise", screenEffect: "glow", screenEffectColor: "cyan" }],
    ["lora", "上方管理故事与导出，中间是故事画布，下方负责输入和选择角色。"],
    ["nia", "先点角色，再在输入框写话；消息就会站到那个角色的位置。", { interaction: { effect: "heart", targetCharacterId: "lora", emoji: "✨", reaction: "bounce" } }],
    ["narrator", "旁白位于中间，适合场景、动作与转场。默认旁白不可编辑，需要有名字的旁白时可以新建角色。"],
    ["guide", "记住：编辑器负责写，演出编辑负责让它动起来。现在你已经认完路啦。", { tokenAnimation: "impact", screenEffect: "warm-glow", screenEffectColor: "gold" }],
  ]),
  lesson({ id: "characters", category: "start", title: "创建第一个角色", summary: "名字、位置、头像与昼夜均可读配色。", duration: "约 2 分钟", level: "入门", points: ["新增角色", "左右位置", "头像配色"], challenge: "新建左右各一名角色，给其中一人换头像，再切换昼夜检查配色。" }, [
    ["lora", "点击底部的“新增角色”，先给角色起一个容易辨认的名字。"],
    ["nia", "位置可选左侧、右侧或旁白。对话双方分居左右，长记录会清楚很多。"],
    ["guide", "有平台身份的日志会尝试获取 QQ、Discord 或 KOOK 头像；获取失败就手动上传。"],
    ["lora", "角色颜色和气泡颜色按角色统一修改，内置配色已经分别检查过亮色与暗色对比度。"],
    ["nia", "角色很多时，点最左侧“角色总览”；手机看紧凑列表，电脑可以快速编辑。", { interaction: { effect: "throw", targetCharacterId: "lora", emoji: "🪪", reaction: "stagger" } }],
    ["guide", "小技巧：再次点击当前选中的角色，可以直接进入角色编辑。", { tokenAnimation: "fade", screenEffect: "ripple", screenEffectColor: "green" }],
  ]),
  lesson({ id: "first-message", category: "start", title: "写下第一幕", summary: "发送、换行、表情和图片语音资源。", duration: "约 2 分钟", level: "入门", points: ["发送", "换行", "资源"], challenge: "写一条两行台词，在句中插入表情，并确认末尾没有多余空行。" }, [
    ["nia", "电脑默认 Enter 发送、Shift+Enter 换行；手机用发送按钮，回车保留给换行。"],
    ["lora", "也可以在界面与输入设置里改“回车行为”，让习惯听你的。"],
    ["guide", "左侧笑脸会把 Emoji 或 QQ 表情插进文本框，因此可以和文字混排，不会立刻发送。"],
    ["lora", "输入框为空时，右侧加号可以添加图片、语音或远程链接；开始打字后，它会让位给发送按钮。"],
    ["nia", "输入框会长到五行，再多才滚动；删回一行时也会自动缩回。"],
    ["guide", "发送前再看一眼选中的角色——把台词塞给旁白，往往会产生非常哲学的事故。", { tokenAnimation: "shake", screenEffect: "flicker", screenEffectColor: "purple", screenEffectRepeat: 2 }],
  ]),

  lesson({ id: "edit-message", category: "edit", title: "修改、引用与删除", summary: "用气泡旁的小铅笔处理单条消息。", duration: "约 2 分钟", level: "入门", points: ["编辑", "引用", "删除"], challenge: "修改一条台词，再让另一名角色引用它作答。" }, [
    ["lora", "每条气泡旁的小铅笔是单条操作入口。电脑会在原气泡就地编辑，手机会打开适合触控的编辑面板。"],
    ["nia", "编辑时原文会保留；回车确认，也可以点确定。点击外部或取消会放弃本次输入。"],
    ["guide", "“引用”会让新消息指向旧消息。演出里还能配置定位到被引用消息，几秒后再回来。"],
    ["lora", "删除只删这一条；如果手滑，先别关页面，可以用浏览器保留的本地草稿重新检查。"],
    ["nia", "操作菜单会避开屏幕边缘，窄屏时自动换行，不需要横向滚动。"],
    ["guide", "编辑的最高境界：少改一句废话，多留一句好梗。", { tokenAnimation: "ghost", screenEffect: "dream", screenEffectColor: "purple" }],
  ]),
  lesson({ id: "insert", category: "edit", title: "上插、下插与多插", summary: "在准确位置补上一条或连续多条消息。", duration: "约 2 分钟", level: "入门", points: ["上插", "下插", "多插"], challenge: "在两条现有消息之间上插一句，再用多插连续补两名角色的回应。" }, [
    ["narrator", "洛拉打开门。"],
    ["lora", "等下，我是不是漏了一句敲门？"],
    ["nia", "点这条消息的小铅笔，再选“上插”，就能在两条消息之间补一条。"],
    ["guide", "上插和下插一次只加一条；需要连续补写时，用“多插”。插入线会明确标出落点。"],
    ["lora", "多插中可以切换下方角色，发送后新消息会依次排在标记位置，不会倒序。"],
    ["nia", "写完记得点“结束”。于是——笃、笃、笃。现在开门就礼貌多了。", { tokenAnimation: "impact", interaction: { effect: "throw", targetCharacterId: "lora", emoji: "🚪", reaction: "bounce" } }],
  ]),
  lesson({ id: "organize", category: "edit", title: "多选、移动与拖动", summary: "整理长记录时不把消息弄丢。", duration: "约 2 分钟", level: "进阶", points: ["多选", "批量移动", "触屏拖动"], challenge: "选中两条不相邻消息整体下移，再拖动其中一条跨过三条消息。" }, [
    ["guide", "选择“多选”后，点气泡加入或取消选择；被选中的消息会有清楚的局部高亮。"],
    ["lora", "上移和下移会整体移动选中消息，内部顺序保持不变。"],
    ["nia", "也可以按住拖动手柄直接挪位置。鼠标与触屏都支持，靠近边缘时页面会慢慢自动滚动。"],
    ["lora", "拖动期间电脑仍能滚动滚轮，所以长达上万条的日志也不用把手腕献祭给滚动条。"],
    ["guide", "完成或再次取消选择会退出多选。移动采用局部更新，不会让整份对话消失再重画。"],
    ["nia", "整理完毕。消息列队成功，没有一条被发配到虚空。", { tokenAnimation: "rise", screenEffect: "curtain", screenEffectColor: "cyan" }],
  ]),

  lesson({ id: "play", category: "performance", title: "开始一场演出", summary: "预览、开始、暂停与手动推进。", duration: "约 2 分钟", level: "入门", points: ["开始演出", "暂停", "手动推进"], challenge: "开始一次手动演出，推进三条后暂停，向上翻看旧消息，再继续播放。" }, [
    ["guide", "点击右上角“演出编辑”，会先看到全部消息，方便检查整体排版。"],
    ["lora", "点击“开始演出”后，配置条会收起；在画布任意空白处点击，就播放下一条。"],
    ["nia", "新气泡会从下方向上淡入，并自动滚到最新消息；你仍然可以自己往上翻。"],
    ["guide", "自动播放开启时，右上角按钮负责暂停与继续；关闭演出或触发返回会回到开始前的位置。"],
    ["lora", "演出中不会出现编辑框、特效标记线或绿色选择框。观众只看故事。"],
    ["nia", "那么，灯光就位——开始！", { tokenAnimation: "impact", screenEffect: "curtain", screenEffectColor: "gold", screenEffectDurationMs: 1200 }],
  ]),
  lesson({ id: "stream", category: "performance", title: "流式文字与节奏", summary: "让词一个个出现，并在重点处停顿。", duration: "约 2 分钟", level: "进阶", points: ["流式输出", "分词", "逐词偏移"], challenge: "把一句话拆成三个节奏词组，让重点词额外停顿 250ms。" }, [
    ["lora", "流式输出会按完整中文词组和英文单词出现，不会吐出半个词。", { stream: true, tokenAnimation: "rise" }],
    ["nia", "速度随机量会让节奏更自然；不想逐词精调时，只调全局就够了。", { stream: true, tokenAnimation: "fade" }],
    ["guide", "单条编排里可以连续点击多个词，再合并为自定义词组；CQ 码会显示成真正的表情或可读内容。"],
    ["lora", "逐词延迟是在智能延迟基础上加减。正数更慢，负数更快，留空就跟随全局。", { stream: true, tokenAnimation: "blur", tokenDelays: { 1: 260, 3: -60 } }],
    ["nia", "想强调一句？给那条消息单独换成重击落字，而不是把全场每句话都砸在地板上。", { stream: true, tokenAnimation: "impact" }],
    ["guide", "节奏不是越花越好：重点处慢，过渡处快，观众才跟得上。", { tokenAnimation: "ghost", screenEffect: "vignette", screenEffectColor: "blue" }],
  ]),
  lesson({ id: "record", category: "performance", title: "录制演出节奏", summary: "用点击记录输入提示与消息停留时间。", duration: "约 2 分钟", level: "进阶", points: ["区间录制", "输入提示", "保存丢弃"], challenge: "选择三条消息录一遍节奏，先丢弃，再录第二遍并保存。" }, [
    ["guide", "录制用于快速记下每条消息的大体时长。开始前可以选择只录一段区间。"],
    ["lora", "录制时会强制手动推进、关闭自动播放和流式输出，避免程序替你抢拍。"],
    ["nia", "若开启输入提示：第一次点击开始“正在输入”，第二次显示完整消息，下一次才推进。"],
    ["guide", "这样会分别记录输入提示时长，以及消息完整出现后停留到下一条的时长。"],
    ["lora", "完成后选择保存写入编排；觉得这遍节奏像踩到香蕉皮，就直接丢弃。"],
    ["nia", "先录出骨架，再逐条微调。比从零填写几百个毫秒数字友好多了。", { interaction: { effect: "throw", targetCharacterId: "lora", emoji: "🍌", reaction: "stagger" }, screenEffect: "shake-light", screenEffectColor: "gold" }],
  ]),

  lesson({ id: "text-effects", category: "effects", title: "文字特效入门", summary: "用不同字动画表达语气，而不是只换颜色。", duration: "约 2 分钟", level: "入门", points: ["字动画", "单条覆盖", "预览"], challenge: "为平静、回忆和强调三句话分别挑一种不同的文字动画并预览。" }, [
    ["guide", "文字特效是预制动画：上浮适合自然出现，模糊聚焦像回忆，重击落字适合强调。"],
    ["lora", "这句话慢慢浮上来。", { stream: true, tokenAnimation: "rise" }],
    ["nia", "这句像从记忆里对焦。", { stream: true, tokenAnimation: "blur" }],
    ["lora", "而这一句——落地！", { stream: true, tokenAnimation: "impact" }],
    ["guide", "选择特效时会在真实气泡上预览；手机全屏弹窗也不会让你只能对着空气猜效果。"],
    ["nia", "全局关着也能给单条开启；全局开着则默认跟随，只有需要时才覆盖。", { tokenAnimation: "ghost", screenEffect: "glow", screenEffectColor: "cyan" }],
  ]),
  lesson({ id: "screen-effects", category: "effects", title: "屏幕特效笔刷", summary: "组合动画底子、预制颜色、时长与重复次数。", duration: "约 3 分钟", level: "进阶", points: ["特效笔刷", "颜色", "播放参数"], challenge: "组合一个只播放一次的冷色冲击，再做一个重复三次的暖色闪烁。" }, [
    ["guide", "演出编辑里选择“特效笔刷”，电脑弹出卡片，手机打开可滚动的全屏窗口。"],
    ["lora", "文字特效和屏幕特效可以在同一页一起配置，再点消息一次应用整套组合。"],
    ["nia", "屏幕效果由动画底子、预制颜色、持续时间、速度与重复次数组成。颜色不会偷偷改变动画。"],
    ["guide", "选择任意底子会立即预览；“预览”按钮会按当前完整参数再播放一次。"],
    ["lora", "边缘冲击应当是薄薄的边缘滤镜，不会把手机上的文字盖住。", { screenEffect: "damage", screenEffectColor: "red", screenEffectDurationMs: 700 }],
    ["nia", "像故障闪烁这样的底子本身只跑一次；需要多闪几次，就明确调高重复次数。", { screenEffect: "flicker", screenEffectColor: "purple", screenEffectRepeat: 3, screenEffectDurationMs: 260 }],
    ["guide", "少量、准确、为剧情服务——特效才是舞台灯，而不是警车灯。", { screenEffect: "warm-glow", screenEffectColor: "gold", tokenAnimation: "impact" }],
  ]),
  lesson({ id: "interaction-effects", category: "effects", title: "互动与持续效果", summary: "让角色头像互动，并把状态延续到后文。", duration: "约 3 分钟", level: "进阶", points: ["角色互动", "持续区间", "角色状态"], challenge: "让一名角色向另一名角色投出 Emoji，并在后续三条消息间维持受伤状态后恢复。" }, [
    ["lora", "互动特效会把两个角色头像放进独立舞台层，因此动作不会推歪消息布局。"],
    ["nia", "比如：送你一颗心。", { interaction: { effect: "heart", targetCharacterId: "lora", emoji: "💗", reaction: "affection" } }],
    ["lora", "也可以扔预制 Emoji、法术、刀刃或子弹，再选择目标如何回应。", { interaction: { effect: "magic", targetCharacterId: "nia", emoji: "✨", reaction: "bounce" } }],
    ["guide", "需要剧情长期变化时，用持续区间：先点起点，再点终点，时间轴线会标出覆盖范围。"],
    ["nia", "角色状态则从某条消息之后一直生效，例如受伤、灰化、离场或阵亡，直到后面添加恢复事件。"],
    ["lora", "单条橡皮只擦单条特效；区间橡皮专门删除持续效果，不会误删文字。"],
    ["guide", "最后用“效果预览”点一条消息，连续区间和角色状态也会一起演示。恭喜，舞台监督毕业！", { tokenAnimation: "impact", screenEffect: "ripple", screenEffectColor: "pink", interaction: { effect: "heart", targetCharacterId: "nia", emoji: "🎓", reaction: "bounce" } }],
  ]),
];

export function cloneTutorialArchive(tutorial: StoryTutorial): StoryArchive {
  return {
    document: structuredClone(tutorial.archive.document),
    assets: new Map(tutorial.archive.assets),
  };
}
