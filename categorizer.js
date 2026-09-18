// categorizer.js
// Decides which category (name + Chrome tab-group color) a tab belongs to,
// using domain rules, then title-keyword rules, then lightweight
// "shared significant words" clustering as a last resort.

export const BUILTIN_RULES = [
  { category: "Dev & Code", color: "blue", domains: [
      "github.com", "gitlab.com", "bitbucket.org", "stackoverflow.com",
      "stackexchange.com", "developer.mozilla.org", "npmjs.com",
      "codepen.io", "replit.com", "vercel.com", "netlify.app",
      "localhost", "127.0.0.1", "docs.python.org", "pypi.org",
      "leetcode.com", "codesandbox.io", "jsfiddle.net"
  ]},
  { category: "AI Tools", color: "purple", domains: [
      "claude.ai", "chatgpt.com", "chat.openai.com", "gemini.google.com",
      "perplexity.ai", "anthropic.com", "openai.com", "huggingface.co"
  ]},
  { category: "Email", color: "cyan", domains: [
      "mail.google.com", "outlook.live.com", "outlook.office.com",
      "mail.yahoo.com", "protonmail.com"
  ]},
  { category: "Docs & Productivity", color: "green", domains: [
      "docs.google.com", "sheets.google.com", "slides.google.com",
      "drive.google.com", "calendar.google.com", "notion.so",
      "notion.site", "dropbox.com", "onedrive.live.com",
      "trello.com", "asana.com", "monday.com", "figma.com"
  ]},
  { category: "Social", color: "pink", domains: [
      "twitter.com", "x.com", "facebook.com", "instagram.com",
      "reddit.com", "linkedin.com", "tiktok.com", "threads.net",
      "discord.com", "snapchat.com"
  ]},
  { category: "Video & Streaming", color: "red", domains: [
      "youtube.com", "netflix.com", "twitch.tv", "hulu.com",
      "primevideo.com", "disneyplus.com", "vimeo.com", "spotify.com"
  ]},
  { category: "Shopping", color: "orange", domains: [
      "amazon.com", "ebay.com", "etsy.com", "walmart.com",
      "target.com", "bestbuy.com", "aliexpress.com"
  ]},
  { category: "News", color: "yellow", domains: [
      "nytimes.com", "cnn.com", "bbc.com", "reuters.com",
      "foxnews.com", "theverge.com", "washingtonpost.com",
      "apnews.com", "npr.org"
  ]},
  { category: "Research & Reference", color: "cyan", domains: [
      "wikipedia.org", "scholar.google.com", "arxiv.org",
      "researchgate.net", "jstor.org"
  ]},
  { category: "Finance", color: "green", domains: [
      "stripe.com", "paypal.com", "wise.com", "mint.intuit.com",
      "coinbase.com", "robinhood.com", "fidelity.com", "chase.com"
  ]},
  { category: "Work", color: "blue", domains: [
      "slack.com", "zoom.us", "meet.google.com", "linear.app",
      "atlassian.net", "jira.com", "confluence.com", "salesforce.com"
  ]},
  { category: "Classes & Learning", color: "yellow", domains: [
      "canvaslms.com", "instructure.com", "blackboard.com", "moodle.org",
      "classroom.google.com", "coursera.org", "edx.org", "udemy.com",
      "khanacademy.org", "quizlet.com", "chegg.com", "gradescope.com",
      "pearson.com", "wiley.com", "cengage.com"
  ]},
  { category: "Nonprofit & Community", color: "pink", domains: [
      "idealist.org", "volunteermatch.org", "catchafire.org", "benevity.org",
      "guidestar.org", "candid.org", "grantstation.com", "grants.gov",
      "donorbox.org", "givebutter.com", "networkforgood.com", "civicrm.org"
  ]}
];

// Fallback keyword rules checked against the tab title when the domain
// doesn't match anything above.
const KEYWORD_RULES = [
  { category: "Shopping", color: "orange", words: ["cart", "checkout", "order", "price", "deal"] },
  { category: "Video & Streaming", color: "red", words: ["watch", "episode", "trailer", "stream"] },
  { category: "Docs & Productivity", color: "green", words: ["spreadsheet", "invoice", "meeting", "agenda"] },
  { category: "Research & Reference", color: "cyan", words: ["tutorial", "documentation", "how to", "guide", "wiki"] },
  { category: "Travel", color: "grey", words: ["flight", "hotel", "itinerary", "booking", "reservation"] },
  { category: "Classes & Learning", color: "yellow", words: ["syllabus", "assignment", "homework", "lecture", "course", "class", "exam", "quiz", "rubric", "office hours"] },
  { category: "Nonprofit & Community", color: "pink", words: ["nonprofit", "non-profit", "volunteer", "donation", "fundraiser", "grant proposal", "community outreach"] }
];

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "at", "by", "your", "you", "how", "what", "this", "that",
  "new", "home", "page", "welcome", "official"
]);

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function domainLabel(url) {
  const hostname = hostnameOf(url);
  if (!hostname) return "";
  const parts = hostname.split(".");
  // This intentionally avoids a full public-suffix dependency while producing
  // useful labels for common domains and subdomains.
  return parts.length > 2 ? parts.slice(-2, -1)[0] : parts[0];
}

/**
 * Extracts common course identifiers (for example CS 101 or BIO-204A) so
 * related LMS pages, assignments, and readings can form a course workspace.
 */
export function courseLabel(tab) {
  const text = `${tab.title || ""} ${tab.url || ""}`.replace(/[-_/.]/g, " ");
  const match = text.match(/\b([A-Z]{2,5})\s*-?\s*(\d{2,4}[A-Z]?)\b/i);
  if (!match) return "";
  return `${match[1].toUpperCase()} ${match[2].toUpperCase()}`;
}

export function classroomCourseId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "classroom.google.com") return "";
    return parsed.pathname.match(/^\/c\/([^/?#]+)/)?.[1] || "";
  } catch { return ""; }
}

/**
 * Classroom usually puts the course name in the tab title. Keep only a useful
 * human label and reject generic Google Classroom pages.
 */
export function classroomCourseName(tab) {
  if (!classroomCourseId(tab.url || "")) return "";
  const title = (tab.title || "")
    .replace(/\s*[-|–]\s*Google Classroom\s*$/i, "")
    .replace(/^Google Classroom\s*[-|–]\s*/i, "")
    .trim();
  return /^(|classroom|stream|classwork|people)$/i.test(title) ? "" : title.slice(0, 80);
}

function domainMatch(hostname, rule) {
  return rule.domains.some(d => hostname === d || hostname.endsWith("." + d));
}

/**
 * @param {{url:string, title:string}} tab
 * @param {Array} customRules - user-defined rules from options page,
 *   shape: [{ category, color, domains: [] }], checked before built-ins.
 * @returns {{name: string, color: string} | null} null means "uncategorized"
 */
export function assignCategory(tab, customRules = []) {
  const hostname = hostnameOf(tab.url || "");
  if (!hostname) return null;

  for (const rule of customRules) {
    if (domainMatch(hostname, rule)) {
      return { name: rule.category, color: rule.color || "grey" };
    }
  }

  for (const rule of BUILTIN_RULES) {
    if (domainMatch(hostname, rule)) {
      return { name: rule.category, color: rule.color };
    }
  }

  const title = (tab.title || "").toLowerCase();
  for (const rule of KEYWORD_RULES) {
    if (rule.words.some(w => title.includes(w))) {
      return { name: rule.category, color: rule.color };
    }
  }

  return null; // caller decides how to bucket uncategorized tabs
}

/**
 * Provides an explainable categorization signal for the UI and automation.
 * Built-in and user rules are high confidence; title matches are softer.
 */
export function classifyTab(tab, customRules = []) {
  const hostname = hostnameOf(tab.url || "");
  if (!hostname) return null;
  for (const rule of customRules) {
    if (domainMatch(hostname, rule)) {
      return { name: rule.category, color: rule.color || "grey", confidence: "high", reason: "custom rule" };
    }
  }
  for (const rule of BUILTIN_RULES) {
    if (domainMatch(hostname, rule)) {
      return { name: rule.category, color: rule.color, confidence: "high", reason: "known site" };
    }
  }
  const title = (tab.title || "").toLowerCase();
  for (const rule of KEYWORD_RULES) {
    if (rule.words.some(word => title.includes(word))) {
      return { name: rule.category, color: rule.color, confidence: "medium", reason: "page topic" };
    }
  }
  return null;
}

/**
 * Lightweight clustering for tabs that fall through every rule above:
 * group uncategorized tabs that share a significant title word.
 * Returns a Map<tabId, clusterLabel>.
 */
export function clusterBySharedWords(tabs) {
  const wordToTabs = new Map();
  for (const tab of tabs) {
    const words = (tab.title || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 3 && !STOPWORDS.has(w));
    const seen = new Set(words);
    for (const w of seen) {
      if (!wordToTabs.has(w)) wordToTabs.set(w, []);
      wordToTabs.get(w).push(tab.id);
    }
  }

  const result = new Map();
  const sortedWords = [...wordToTabs.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [word, tabIds] of sortedWords) {
    if (tabIds.length < 2) continue;
    const unclaimed = tabIds.filter(id => !result.has(id));
    if (unclaimed.length < 2) continue;
    const label = word[0].toUpperCase() + word.slice(1);
    for (const id of unclaimed) result.set(id, label);
  }
  return result;
}

export function categoryColorPalette() {
  return ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
}
