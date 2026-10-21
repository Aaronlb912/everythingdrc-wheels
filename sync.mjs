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

// The bot keeps one card per channel, edited in place: short how-to on top,
// this week's list with jump links below. Pin it once in Discord.
const COLOR = 0xe2552e;
const LABELS = {
  food: { title: "Food", noun: "food", emoji: "🍕" },
  games: { title: "Game", noun: "game", emoji: "🎮" },
  music: { title: "Song", noun: "song", emoji: "🎵" },
  gym: { title: "Gym", noun: "gym challenge", emoji: "🏋️" },
};
const resetAt = Math.floor(since.getTime() / 1000) + 7 * 86400;
function cardEmbed(cat) {
  const l = LABELS[cat], it = lists[cat];
  let body = "";
  for (const [i, [name, v, link]] of it.entries()) {
    const line = (i + 1) + ". [" + name.replace(/[[\]]/g, "") + "](" + link + ") · **" + v + "** 👍\n";
    if ((body + line).length > 3400) { body += "...and " + (it.length - i) + " more."; break; }
    body += line;
  }
  return {
    color: COLOR,
    title: l.emoji + " " + l.title + " wheel",
    description: [
      "👍 **Vote:** tap a name below and react 👍",
      "✍️ **Suggest:** type a " + l.noun + " in this channel, one per message",
      "🎡 **Win:** most 👍 gets the biggest slice. Dennis spins at the end of the week.",
      "",
      "**This week**",
      it.length ? body.trim() : "Nothing yet. Be the first!",
      "",
      "Resets <t:" + resetAt + ":R>",
    ].join("\n"),
    footer: { text: "Wheel Sync · updates every 15 minutes" },
  };
}
async function keep(key, channel, embed) {
  const text = JSON.stringify(embed), old = boards[key];
  if (old && old.text === text) return;
  const body = { content: "", embeds: [embed] };
  try {
    let msg = null;
    if (old?.id) msg = await api("/channels/" + channel + "/messages/" + old.id, "PATCH", body).catch(() => null);
    // An edit that comes back without the embed is useless; post a new card.
    if (!msg?.embeds?.length) msg = await api("/channels/" + channel + "/messages", "POST", body);
    boards[key] = { id: msg.id, text };
  } catch (e) {
    console.warn("::warning::Couldn't post " + key + ": " + e.message);
  }
}
const boards = { ...(prev.boards || {}) };
for (const [cat, id] of Object.entries(CHANNELS)) {
  if (!id) continue;
  // Older versions kept two messages per channel; clear them out.
  for (const k of [cat, cat + "_how"]) {
    if (!boards[k]) continue;
    await api("/channels/" + id + "/messages/" + boards[k].id, "DELETE").catch(() => null);
    delete boards[k];
  }
  await keep(cat + "_card", id, cardEmbed(cat));
}
// One post per channel when the week flips, and a last call on Saturday (ET).
const posted = { ...(prev.posted || {}) }, wk = since.toISOString();
const etDay = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })).getDay();
async function say(channel, embed) {
  await api("/channels/" + channel + "/messages", "POST", { embeds: [{ color: COLOR, ...embed }] })
    .catch(e => console.warn("::warning::Couldn't post nudge: " + e.message));
}
if (prev.weekStart && prev.weekStart !== wk && posted.reset !== wk) {
  for (const [cat, id] of Object.entries(CHANNELS)) if (id)
    await say(id, { title: "🔄 New week, fresh " + LABELS[cat].noun + " wheel", description: "Last week's list is cleared. Type a " + LABELS[cat].noun + " here to suggest it, and check the pinned card to vote." });
  posted.reset = wk;
}
if (etDay === 6 && posted.lastCall !== wk) {
  for (const [cat, id] of Object.entries(CHANNELS)) {
    if (!id) continue;
    const top = lists[cat].slice(0, 3).map(([n, v, link], i) => ["🥇", "🥈", "🥉"][i] + " [" + n.replace(/[[\]]/g, "") + "](" + link + ") · " + v + " 👍").join("\n");
    await say(id, { title: "⏰ Last call for " + LABELS[cat].noun + " votes", description: (top || "Nothing suggested yet. There's still time!") + "\n\nThe wheel spins soon. React 👍 on your favorite." });
  }
  posted.lastCall = wk;
}
const next = { weekStart: since.toISOString(), lists, boards, posted };
if (JSON.stringify({ weekStart: prev.weekStart, lists: prev.lists, boards: prev.boards, posted: prev.posted || {} }) === JSON.stringify(next)) {
  console.log("no change");
} else {
  fs.writeFileSync("data.json", JSON.stringify({ ...next, updated: new Date().toISOString() }, null, 1) + "\n");
  console.log("updated", Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length])));
}
