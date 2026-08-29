/* ponytail self-check — the smallest thing that fails if the new feedback /
   experience / interaction logic breaks. Bundled with vite, then run under node.
   Run: npm run selfcheck */

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => void store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

const assert = (cond: unknown, msg: string): void => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
};

const mm = await import("../src/memoryManager");
const ix = await import("../src/interaction");

/* ---- feedback capture: distinct keys, latest-wins conflicts ---- */
assert(mm.captureFeedback("I hate repetitive quizzes, I like guessing games.") === 2, "captures both EN prefs");
let prefs = mm.recallPreferences(10);
let texts = prefs.map((p) => p.text);
const isLike = (t: string) => /\blikes\b/.test(t);
assert(prefs.length === 2, "two distinct preferences kept");
assert(texts.some((t) => /dislikes/.test(t) && t.includes("repetitive quizzes")), "negative stored");
assert(texts.some((t) => isLike(t) && t.includes("guessing games")), "positive stored");
assert(new Set(prefs.map((p) => p.meta?.key)).size === 2, "distinct keys — no collide-and-overwrite");

assert(mm.captureFeedback("I like quizzes now.") === 1, "conflicting like captured");
prefs = mm.recallPreferences(10);
texts = prefs.map((p) => p.text);
const quizPrefs = texts.filter((t) => t.toLowerCase().includes("quiz"));
assert(quizPrefs.length === 1 && isLike(quizPrefs[0]), "latest wins on same topic (no duplicate)");

assert(mm.captureFeedback("我不喜欢重复的猜谜，我喜欢看故事。") === 2, "captures both ZH prefs");
const zh = mm.recallPreferences(10).map((p) => p.text);
const zhIsLike = (t: string) => /\blikes\b/.test(t);
assert(zh.some((t) => /dislikes/.test(t) && t.includes("猜谜")), "ZH negative stored");
assert(zh.some((t) => zhIsLike(t) && t.includes("看故事")), "ZH positive stored");
assert(!zh.some((t) => zhIsLike(t) && t.includes("猜谜")), "negated pattern never becomes a like");

/* ---- experience memory + novelty ---- */
mm.recordExperience("guessing game", "satisfied");
mm.recordExperience("guessing game", "satisfied");
mm.recordExperience("quiz", "satisfied");
const exp = mm.recentExperiences(10);
assert(exp.filter((e) => e.activity === "guessing game").length === 1, "consecutive repeats merge");
assert(mm.noveltyHint().includes("guessing game"), "novelty hint names the activity");

/* ---- active interaction state ---- */
const it = ix.startInteraction("guessing_game", "a mango", "user finds your secret");
assert(ix.getActiveInteraction()?.id === it.id, "interaction persisted");
ix.updateInteraction({ score: 3, difficulty: 4 });
assert(ix.getActiveInteraction()?.score === 3, "interaction updated");
assert(ix.formatInteraction(ix.getActiveInteraction()!).includes("guessing_game"), "format includes type");
const ended = ix.stopInteraction();
assert(ended?.id === it.id && ix.getActiveInteraction() === null, "interaction closed");

console.log("selfcheck OK");