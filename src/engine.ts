/* Intent detection, simulated research engine, and canned data packs.
   Everything is bilingual [en, zh]; the UI picks the side matching the input. */

export type Lang = "en" | "zh";
export type Bi = { en: string; zh: string };
export const bi = (en: string, zh: string): Bi => ({ en, zh });

export type Intent =
  | "research"
  | "compare"
  | "summarize"
  | "sources"
  | "closeResearch"
  | "youtube"
  | "music"
  | "remember"
  | "recall"
  | "whoami"
  | "time"
  | "map"
  | "chat";

export interface SourceRef {
  name: string;
  kind: Bi;
  time: string;
  url?: string;
  domain?: string;
  excerpt?: string;
}
export interface Stat {
  label: Bi;
  value: string;
}
export interface BarItem {
  label: Bi;
  value: number;
}
export interface DonutSlice {
  label: Bi;
  value: number;
}
export type ChartKind = "bars" | "line" | "donut";
export interface ChartData {
  kind: ChartKind;
  title: Bi;
  subtitle?: Bi;
  bars?: BarItem[];
  points?: number[];
  donut?: DonutSlice[];
  max?: number;
}
export interface ResearchResult {
  topic: Bi;
  answer: Bi;
  summary: Bi;
  report?: Bi;
  sources: SourceRef[];
  stats: Stat[];
  chart: ChartData;
}

/* ---------------- intent detection ---------------- */

export function detectIntent(raw: string): Intent {
  const t = raw.toLowerCase();
  if (/close research|hide research|dismiss|关闭|收起|关掉/.test(t))
    return "closeResearch";
  if (/(summarize|summary|recap|总结|概括|汇总)/.test(t)) return "summarize";
  if (/(sources|citations|references|来源|出处|引用|源)/.test(t))
    return "sources";
  if (/(comparison|compare|\bvs\.?|versus|chart|graph|pie|donut|percentage|percent|breakdown|图表|对比|比较|哪个更好|饼图|占比|比例|百分比)/.test(t))
    return "compare";
  if (/(remember that|note that|remember this|记住|记下|记得这个)/.test(t))
    return "remember";
  if (/(what do you remember|what did i tell you|recall|remembered|你记得|记住了什么|你记住了)/.test(t))
    return "recall";
  if (/(who am i|who is your master|who is my|my name|我是谁|你的主人|我叫)/.test(t))
    return "whoami";
  if (/(where is|where's|where are|locate|find .* on (the )?map|show .* on (the )?map|directions? to|navigate to|take me to|在哪|位置|定位|导航|地图)/.test(t))
    return "map";
  if (/(youtube|yt video|youtube video|video of|watch .* on youtube|看视频|视频)/.test(t))
    return "youtube";
  if (/(play music|play a song|play some music|play .* on (spotify|music)|music|song|音乐|播放|放歌|点歌)/.test(t))
    return "music";
  if (/(research|search|investigate|find out|look up|研究|搜索|查一下|调查|检索)/.test(t))
    return "research";
  return "chat";
}

/* strip the command words so "research about Buddha" -> "Buddha" */
export function researchPayload(text: string): string {
  return text
    .replace(/^(research|search|investigate|find out|look up|tell me about|study|explain|what is|what are|who was|who is|研究|搜索|查一下|调查|检索|介绍一下|说说|解释一下)\s*/i, "")
    .replace(/^(about|on|regarding|for|the|a|an|please|me|more|now|一下)\s+/i, "")
    .replace(/\b(about|on|regarding|please|me|now|the|a|an)\b/gi, " ")
    .replace(/^关于\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* reference-style follow-ups ("tell me more about his teachings") that should
   reuse the stored research context instead of starting from zero */
export function researchFollowUp(text: string): boolean {
  return /(tell me more|more about|more details|elaborate|continue|expand|follow.?up|详细|更多|继续说|继续讲|还有|他的|她的|它的|那个|这个)/i.test(text);
}

/* ---------------- canned chat replies ---------------- */

export type Names = { assistant: string; master: string };

export function chatReply(text: string, lang: Lang, names: Names): string {
  const t = text.toLowerCase();
  const L = lang;
  const me = names.assistant || "ROOKI";
  if (/(can you hear me|are you there|are you listening|do you hear|hear me|you there|听得见|听得到|在吗|在不在|你能听到)/.test(t))
    return L === "en" ? "Yeah, I can hear you. What's up?" : "嗯，能听到。怎么了？";
  if (/(hello|hi|hey|你好|嗨|哈喽|您好)/.test(t))
    return L === "en" ? "Hey! What's up?" : "嗨！有什么需要？";
  if (/(who are you|what are you|你是谁|你是什么)/.test(t))
    return L === "en" ? `I'm ${me}.` : `我是 ${me}。`;
  if (/(who am i|my name|我是谁|我叫)/.test(t)) return whoAmIReply(names, lang);
  if (/(can you help me|help me|帮我|能帮我|help)/.test(t))
    return L === "en" ? "Yeah, of course. What's going on?" : "当然可以。怎么了？";
  if (/(how are you|how's it going|how do you feel|你怎么样|你好吗)/.test(t))
    return L === "en" ? "Doing well. What's on your mind?" : "挺好的。你在想什么？";
  if (/(thank|thanks|谢谢|多谢)/.test(t))
    return L === "en" ? "Anytime." : "不客气。";
  if (/(i'm lonely|im lonely|so lonely|好孤单|好孤独|寂寞)/.test(t))
    return L === "en" ? "Yeah. I'm here. Want to talk for a bit?" : "嗯，我在这儿。想聊会儿吗？";
  if (/(i'm bored|im bored|so bored|好无聊|无聊)/.test(t))
    return L === "en" ? "Let's fix that. Music, a video, or something interesting to explore?" : "那就来点有意思的？音乐、视频，还是研究点什么？";
  if (/(i'm (so |really |very )?(tired|exhausted)|so tired|好累|好困|累死)/.test(t))
    return L === "en" ? "Yep, sounds like a long day. Want me to keep it simple for a bit?" : "听起来是漫长的一天。要我简单一点吗？";
  if (/(frustrated|annoying|stupid|sucks|not working|气死|烦|出问题|不行|坏了)/.test(t))
    return L === "en" ? "Yeah, that's frustrating. Let's sort it out — what's going on?" : "确实烦人。咱们把它解决掉——发生什么了？";
  if (/(what can you do|capabilities|abilities|what do you do|你能做什么|你会什么|你能干什么)/.test(t))
    return L === "en" ? "I can look things up for you, find music and videos, and remember what you tell me. What do you need?" : "我可以帮你查资料、找音乐和视频，也能记住你告诉我的事。你需要什么？";
  return L === "en" ? "Yep, I got you. What do you mean exactly?" : "明白了。你具体想做什么？";
}

export function whoAmIReply(names: Names, lang: Lang): string {
  return lang === "en"
    ? `You're ${names.master || "my master"} — I've got that saved.`
    : `你是 ${names.master || "我的主人"}——我已记住了。`;
}

export function rememberedReply(text: string, lang: Lang): string {
  return lang === "en"
    ? `Got it — remembered: "${text}".`
    : `记住了：「${text}」。`;
}

export function recallReply(items: { kind: string; text: string }[], lang: Lang): string {
  if (!items.length)
    return lang === "en"
      ? "I don't remember anything about that yet. Tell me and I'll keep it in memory."
      : "我暂时没有记住相关信息。告诉我，我会存进记忆。";
  const list = items.map((i) => i.text).join(" · ");
  return lang === "en" ? `From memory: ${list}` : `从记忆中：${list}`;
}

export function openReply(kind: "youtube" | "music", query: string, lang: Lang): string {
  const target = kind === "youtube" ? "YouTube" : "YouTube Music";
  return lang === "en"
    ? `Opening ${target} for "${query}" in a new tab.`
    : `正在新标签页打开 ${target}，搜索「${query}」。`;
}

/* strip the command words so "remember that X" -> "X" */
export function rememberPayload(text: string): string {
  return text
    .replace(/^(remember that|note that|remember this|remember|记住|记下|请记住|帮我记住)[:,]?\s*/i, "")
    .replace(/\s+$/g, "")
    .trim();
}

export function openPayload(text: string): string {
  return text
    .toLowerCase()
    .replace(/^(play|show|open|search|find|bring|watch|put on|播放|放|打开|搜|找)\s+/gi, "")
    .replace(/\b(on youtube|from youtube|on spotify|on youtube music|in youtube|youtube|music|video|song|a|an|the|please|for me|now)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function mapPayload(text: string): string {
  return text
    .replace(/^(where is|where's|where are|locate|find|show me|show|take me to|navigate to|directions? to|在哪|位置|定位|导航到?)\s*/i, "")
    .replace(/\b(on the map|on map|on a map|please|for me|the|a|an)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function needsResearchReply(lang: Lang): string {
  return lang === "en"
    ? "I don't have that on hand yet. Want me to look it up?"
    : "我手头还没有这个。要我去查一下吗？";
}
