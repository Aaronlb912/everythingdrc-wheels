// Reads this week's suggestions from Discord and writes data.json for the wheel.
// A suggestion is one message; its votes are the 👍 reactions on it.
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error("DISCORD_TOKEN secret is missing"); process.exit(1); }

// Add a channel ID here to make that tab fill on its own. null = paste only.
const CHANNELS = {
  food: "1562541058288779357",
  games: "1562529876739760138",
  music: "1562529917546274817",
  gym: null,
};

const GUILD = "1533847576619520082";

// Week starts Monday 00:00 US Eastern.
function weekStart(now = new Date()) {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const offset = now - et;
  et.setHours(0, 0, 0, 0);
  et.setDate(et.getDate() - ((et.getDay() + 6) % 7));
  return new Date(Math.round((et.getTime() + offset) / 60000) * 60000);
}

async function api(path, method = "GET", body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch("https://discord.com/api/v10" + path, {
      method,
      headers: { Authorization: "Bot " + TOKEN, ...(body && { "Content-Type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
    if (r.status === 429) { const wait = ((await r.json()).retry_after || 1) * 1000; await new Promise(s => setTimeout(s, wait)); continue; }
    if (!r.ok) throw new Error(path + " -> " + r.status + " " + (await r.text()));
    return r.json();
  }
  throw new Error(path + " -> rate limited");
}

function entryName(m) {
  // Carl-bot posts suggestions as embeds; people post plain text.
  const raw = m.content || m.embeds?.[0]?.description || m.embeds?.[0]?.title || "";
  return raw.split("\n")[0].replace(/<a?:\w+:\d+>|[*_~`>]/g, "").trim().slice(0, 40);
}

async function channelEntries(id, since) {
  const out = [];
  let before = "";
  for (let page = 0; page < 10; page++) {
    const msgs = await api(`/channels/${id}/messages?limit=100${before}`);
    if (!msgs.length) break;
    for (const m of msgs) {
      if (new Date(m.timestamp) < since) return out;
      // Pinned posts are the how-to and the weekly list, not suggestions.
      if (m.pinned) continue;
      const name = entryName(m);
      if (!name) continue;
      const up = m.reactions?.find(r => r.emoji.name === "👍")?.count || 0;
      // Bot posts without a 👍 are setup or system messages, not suggestions.
      if (m.author.bot && !up) continue;
      // Bots that auto-react (Carl-bot) add one 👍 of their own.
      out.push([name, Math.max(0, m.author.bot ? up - 1 : up), `https://discord.com/channels/${GUILD}/${id}/${m.id}`]);
    }
    before = "&before=" + msgs[msgs.length - 1].id;
  }
  return out;
}

const since = weekStart();
const lists = {};
for (const [cat, id] of Object.entries(CHANNELS)) {
  if (!id) continue;
  const merged = new Map();
  for (const [name, v, link] of await channelEntries(id, since)) {
    const k = name.toLowerCase();
    const cur = merged.get(k);
    // Repeats add their votes to the first post, which keeps the link.
    merged.set(k, cur ? [cur[0], cur[1] + v, cur[2]] : [name, v, link]);
  }
  lists[cat] = [...merged.values()].sort((a, b) => b[1] - a[1]).slice(0, 40);
}

const fs = await import("node:fs");
let prev = {};
try { prev = JSON.parse(fs.readFileSync("data.json", "utf8")); } catch {}

// The bot keeps two messages per channel, edited in place: a how-to card and
// this week's list with jump links. Pin both once in Discord.
const WHEEL = "https://aaronlb912.github.io/everythingdrc-wheels/";
const COLOR = 0xe2552e;
const LABELS = {
  food: { title: "Food Review Wednesday", noun: "food", emoji: "🍕" },
  games: { title: "Game of the week", noun: "game", emoji: "🎮" },
  music: { title: "Song of the week", noun: "song", emoji: "🎵" },
  gym: { title: "Gym challenge", noun: "gym challenge", emoji: "🏋️" },
};
const resetAt = Math.floor(since.getTime() / 1000) + 7 * 86400;
function howEmbed(cat) {
  const l = LABELS[cat];
  return {
    color: COLOR,
    title: "🎡 How the " + l.title + " wheel works",
    url: WHEEL + "#" + cat,
    description: [
      "**1. Check the list first.** The pinned 📋 list shows everything suggested this week. If your " + l.noun + " is already there, tap it and react 👍.",
      "**2. New idea?** Post it here, one " + l.noun + " per message." + (cat === "food" ? " You can also use `/suggestion suggest`." : ""),
      "**3. Vote.** React 👍 on any suggestion you like. Every 👍 makes its slice of the wheel bigger.",
      "**4. Spin.** At the end of the week Dennis spins the wheel and posts the winner in announcements.",
      "**5. Reset.** Everything starts fresh on Monday.",
    ].join("\n\n"),
    footer: { text: "Wheel Sync · the list updates every 15 minutes" },
  };
}
function listEmbed(cat) {
  const l = LABELS[cat], it = lists[cat];
  let body = "";
  for (const [i, [name, v, link]] of it.entries()) {
    const line = (i + 1) + ". [" + name.replace(/[[\]]/g, "") + "](" + link + ") · **" + v + "** 👍\n";
    if ((body + line).length > 3800) { body += "...and " + (it.length - i) + " more on the wheel page."; break; }
    body += line;
  }
  return {
    color: COLOR,
    title: "📋 This week's " + l.noun + " suggestions",
    description: (it.length ? "Tap a name to jump to it and react 👍. Already listed? Vote instead of posting it again.\n\n" + body.trim()
      : "Nothing yet this week. Post the first " + l.noun + "!") + "\n\nResets <t:" + resetAt + ":R>.",
    footer: { text: "Wheel Sync · " + it.length + " suggestion" + (it.length === 1 ? "" : "s") + " · updates every 15 minutes" },
  };
}
async function keep(key, channel, embed) {
  const text = JSON.stringify(embed), old = boards[key];
  if (old && old.text === text) return;
  const body = { content: "", embeds: [embed] };
  try {
    let msg = null;
    if (old?.id) msg = await api("/channels/" + channel + "/messages/" + old.id, "PATCH", body).catch(() => null);
    if (!msg) msg = await api("/channels/" + channel + "/messages", "POST", body);
    boards[key] = { id: msg.id, text };
  } catch (e) {
    console.warn("::warning::Couldn't post " + key + ": " + e.message);
  }
}
const boards = { ...(prev.boards || {}) };
for (const [cat, id] of Object.entries(CHANNELS)) {
  if (!id) continue;
  await keep(cat + "_how", id, howEmbed(cat));
  await keep(cat, id, listEmbed(cat));
}

const next = { weekStart: since.toISOString(), lists, boards };
if (JSON.stringify({ weekStart: prev.weekStart, lists: prev.lists, boards: prev.boards }) === JSON.stringify(next)) {
  console.log("no change");
} else {
  fs.writeFileSync("data.json", JSON.stringify({ ...next, updated: new Date().toISOString() }, null, 1) + "\n");
  console.log("updated", Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length])));
}
