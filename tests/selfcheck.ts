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
const li = await import("../src/locationIntel");
const tl = await import("../src/tools");

/* ---- location: "Locate Sri Shakti Theatre, Tirupur" must resolve to
   Sri Sakthi Cinemas (Tiruppur), not the similarly-named temple in Mettupalayam.
   This is the classic cross-transliteration case (shakti↔sakthi, tirupur↔tiruppur)
   — the scoring must absorb that noise offline, no research needed. ---- */
const sriSakthi = {
  name: "Sri Sakthi Cinemas, Sri Sakthi Theatre, 256, Union Mill Road, KPN Colony, Valipalayam, Tiruppur, Tamil Nadu, India",
  city: "Tiruppur",
  region: "Tamil Nadu",
  country: "India",
  latitude: 11.1042,
  longitude: 77.3437,
  address: "Sri Sakthi Cinemas, Sri Sakthi Theatre, 256, Union Mill Road, KPN Colony, Valipalayam, Tiruppur, Tamil Nadu, India",
  category: "cinema",
};
const meTupalayam = {
  name: "Sri Shakti Ayyappan Temple, Mettupalayam, Coimbatore, Tamil Nadu, India",
  city: "Mettupalayam",
  region: "Tamil Nadu",
  country: "India",
  latitude: 11.3021,
  longitude: 76.9446,
  address: "Sri Shakti Ayyappan Temple, Mettupalayam, Coimbatore, Tamil Nadu, India",
  category: "place_of_worship",
};
const ranked = li.scorePlaceCandidates("sri shakti theatre tirupur", "tirupur", [sriSakthi, meTupalayam]);
assert(ranked[0]?.candidate === sriSakthi, "messy-transliteration query ranks Sri Sakthi Cinemas (Tiruppur) first");
assert(ranked[0]!.score / 60 >= 0.25, "top candidate clears the 0.25 resolvePlace confidence bar");

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

/* ---- chart series normalization: labels/values stay paired, zeros are data ---- */
const cs = tl.normalizeChartSeries({
  labels: ["2021", "2011", "2001", ""],
  values: [73.8, 14.3, 43.1, 0],
});
assert(cs !== null && cs.length === 3, "empty label dropped, zero value kept");
assert(cs && cs[0].label === "2021" && cs[0].value === 73.8, "label/value pairs stay aligned");
assert(cs && cs.every((p) => p.label), "no blank labels");
assert(tl.normalizeChartSeries({}) === null, "missing arrays rejected");
assert(tl.normalizeChartSeries({ labels: ["only"], values: [100] }) === null, "single point rejected");
assert(tl.normalizeChartSeries({ labels: [1, 2, 3], values: ["10", "nope", 20] }).length === 2, "non-numeric value dropped");

/* ---- donut rounding: integer percentages always sum to 100 ---- */
for (const vals of [[60, 25, 15], [1, 1, 1], [0.4, 0.4, 0.4], [99.9, 0.05, 0.05], [7, 7, 7, 7, 7, 80]]) {
  const p = tl.donutPercent(vals);
  assert(p.length === vals.length && p.reduce((s, v) => s + v, 0) === 100, `donutPercent sums to 100 (${JSON.stringify(vals)})`);
  assert(p.every((v) => v >= 0), "donutPercent has no negative slices");
}

/* ---- chart intent gates: when to use inline data / reuse / horizontal ---- */
assert(tl.dataNumberCount("Show me a chart of 10,20,30,40") === 4, "bare number list detected as data");
assert(tl.dataNumberCount("Compare A 40, B 30, C 20.") === 3, "labeled comparisons detected");
assert(tl.dataNumberCount("from 2020 to 2026") === 0, "years alone are not data");
assert(tl.dataNumberCount("2021 is 73.8 million, growth 14.3% from 2001 to 2011") === 2, "decimals count, years excluded");
assert(tl.chartRequestIntent("Make it horizontal").horizontal, "horizontal modifier detected");
assert(tl.chartRequestIntent("Rank these values").horizontal, "rank implies horizontal bars");
assert(tl.chartRequestIntent("Show as a percentage chart").percent, "percent intent detected");
assert(tl.chartRequestIntent("use a pie chart").pie && !tl.chartRequestIntent("use a pie chart").percent, "pie detected separately from percent");
assert(tl.isChartReference("Show that as a chart"), "'that' resolves as a modifier");
assert(tl.isChartReference("Change it to a line chart"), "'change it' resolves as a modifier");
assert(!tl.isChartReference("Show a chart comparing Apple and Microsoft revenue"), "long fresh subject is not a modifier");
assert(!tl.isChartReference("Chart of India"), "short fresh subject without modifier words is not a modifier");

console.log("selfcheck OK");