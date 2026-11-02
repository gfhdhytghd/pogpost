/** Conservative on-stream filter: reject lines rather than echoing sensitive fragments. */
// ROT13 keeps offensive vocabulary out of the public source display; it is not encryption.
const decodeWords = (value) =>
  value.replace(/[a-z]/gi, (char) =>
    String.fromCharCode(
      char.charCodeAt(0) + (char.toLowerCase() <= "m" ? 13 : -13),
    ),
  );
const BLOCKED = [
  new RegExp(
    decodeWords(
      "\\o(?:avtt(?:re|n)f?|sntt?bgf?|xvxrf?|puvaxf?|genaa(?:l|vrf))\\o",
    ),
    "i",
  ),
  /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i,
  /(?:\+?\d[\d .()-]{7,}\d)/,
  /\b\d{1,5}\s+[a-z][a-z .'-]+\s(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr)\b/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /\b(?:sk-(?:proj-)?[a-z0-9_-]{12,}|oauth:[a-z0-9]+|bearer\s+\S+)\b/i,
  /\b(?:password|access[_ -]?token|refresh[_ -]?token)\s*[:=]/i,
];
// Compatibility normalization is shared by server, engine and browser.
const INVISIBLE = /[\p{Cf}\u034f\u180b-\u180f\ufe00-\ufe0f]/u;
const LOOKALIKES = {
  а: "a",
  А: "a",
  е: "e",
  Е: "e",
  і: "i",
  І: "i",
  ӏ: "l",
  о: "o",
  О: "o",
  р: "p",
  Р: "p",
  с: "c",
  С: "c",
  у: "y",
  У: "y",
  х: "x",
  Х: "x",
  ѕ: "s",
  Ѕ: "s",
  ј: "j",
  Ј: "j",
  к: "k",
  К: "k",
  м: "m",
  М: "m",
  т: "t",
  Т: "t",
  в: "b",
  В: "b",
  н: "h",
  Н: "h",
  α: "a",
  Α: "a",
  ο: "o",
  Ο: "o",
  ι: "i",
  Ι: "i",
  ε: "e",
  Ε: "e",
  τ: "t",
  Τ: "t",
  ν: "v",
  Ν: "n",
  ρ: "p",
  Ρ: "p",
  χ: "x",
  Χ: "x",
};
const LEET = {
  0: "o",
  1: "i",
  3: "e",
  4: "a",
  5: "s",
  7: "t",
  8: "b",
  9: "g",
  "!": "i",
  $: "s",
  "@": "a",
};
export function canonicalIdentity(value) {
  return [...normalizeText(value).toLowerCase()]
    .map((char) => LOOKALIKES[char] || char)
    .join("");
}
export function normalizeText(value) {
  if (
    typeof value !== "string" ||
    value.length > 20000 ||
    INVISIBLE.test(value)
  )
    return "";
  return value
    .normalize("NFKC")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function screeningSkeleton(value) {
  return [...value.normalize("NFKC").toLowerCase()]
    .map((c) => LOOKALIKES[c] || LEET[c] || c)
    .join("")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]/g, "");
}
export function createTextPolicy({ bannedWords = [] } = {}) {
  const custom = bannedWords.map(screeningSkeleton).filter(Boolean);
  const wordPattern = new RegExp(BLOCKED[0].source.replaceAll("\\b", ""), "i");
  const screen = (text) => {
    const skeleton = screeningSkeleton(text);
    const canonical = [...text.toLowerCase()]
      .map((c) => LOOKALIKES[c] || c)
      .join("");
    const compact = canonical.replace(/\s+/g, "");
    return (
      !wordPattern.test(skeleton) &&
      !custom.some((word) => skeleton.includes(word)) &&
      !BLOCKED.slice(1).some(
        (pattern) => pattern.test(canonical) || pattern.test(compact),
      ) &&
      !/\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]*\b/i.test(canonical)
    );
  };
  const safe = (value, fallback = "", maxLength = 200) => {
    const text = normalizeText(value);
    if (!text || !screen(text)) return fallback;
    return text.slice(0, maxLength);
  };
  return {
    safeText: safe,
    safeLines: (value) =>
      String(value || "")
        .split(/\r?\n/)
        .map((line) => safe(line))
        .filter(Boolean)
        .slice(-40)
        .join("\n"),
    command: (value) =>
      canonicalIdentity(safe(value, "", 200))
        .replace(/^!/, "")
        .replace(/\s+/g, " "),
  };
}
const policy = createTextPolicy();
export const safeText = policy.safeText;
export const safeLines = policy.safeLines;
export const normalizeCommand = policy.command;
export function filterSceneText(config, policy = { safeText }) {
  const safeText = policy.safeText;
  config.meta.title = safeText(config.meta.title, "Chat gets a rematch", 140);
  config.instruction = safeText(
    config.instruction,
    "Follow the chat commands.",
    240,
  );
  for (const entity of config.scene.entities)
    if (entity.text !== undefined) entity.text = safeText(entity.text);
  return config;
}
