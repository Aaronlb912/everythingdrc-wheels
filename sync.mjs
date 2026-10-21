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
    return r.status === 204 ? null : r.json();
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
// Extra channels are found by name so emoji prefixes don't matter.
const guildChannels = await api("/guilds/" + GUILD + "/channels").catch(() => []);
const chan = part => guildChannels.find(c => c.type === 0 && c.name.includes(part))?.id;
const msgLink = (ch, id) => "https://discord.com/channels/" + GUILD + "/" + ch + "/" + id;

// Wheel picks: the wheel page's "Post to #announcements" message names the winner.
// Newest post per category wins, so a re-spin just needs a new post, and deleting
// the post clears the pick. Posts in the first 12 hours of Monday count for the
// week before, in case Dennis spins late.
const TITLES = { "Food Review Wednesday": "food", "Game of the week": "games", "Song of the week": "music", "Gym challenge": "gym" };
const GRACE = 12 * 3600000, lastWkStart = new Date(since - 7 * 86400000).toISOString();
const picks = { [since.toISOString()]: {}, [lastWkStart]: {} };
const annCh = chan("announcements");
if (annCh) {
  const msgs = await api("/channels/" + annCh + "/messages?limit=100").catch(e => (console.warn("::warning::Can't read announcements: " + e.message), []));
  for (const m of msgs) {
    const hit = m.webhook_id && m.content.match(/^🎡 \*\*(.+?) winner:\*\* (.+) \(\d+ 👍\)$/u);
    const cat = hit && TITLES[hit[1]];
    const week = picks[weekStart(new Date(new Date(m.timestamp) - GRACE)).toISOString()];
    if (cat && week && !week[cat]) week[cat] = { name: hit[2].slice(0, 60), link: msgLink(annCh, m.id) };
  }
}
const pickNow = picks[since.toISOString()], pickLast = picks[lastWkStart];
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
      ...(pickNow[cat] ? ["🎡 **Wheel pick:** [" + pickNow[cat].name.replace(/[[\]]/g, "") + "](" + pickNow[cat].link + ")", ""] : []),
      "**This week**",
      it.length ? body.trim() : "Nothing yet. Be the first!",
      "",
      "Resets <t:" + resetAt + ":R>",
    ].join("\n"),
    footer: { text: "Wheel Sync · updates every 5 minutes" },
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
const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
const etDay = etNow.getDay();
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
// Winner history: when the week flips, post last week's most voted and an all-time tally.
const wins = JSON.parse(JSON.stringify(prev.wins || {}));
if (prev.weekStart && prev.weekStart !== wk && posted.winners !== wk && Date.now() - since >= GRACE) {
  const lines = [];
  for (const cat of Object.keys(CHANNELS)) {
    const top = prev.lists?.[cat]?.[0], pick = pickLast[cat];
    if (pick) lines.push(LABELS[cat].emoji + " **" + LABELS[cat].title + " (wheel):** [" + pick.name + "](" + pick.link + ")");
    if (!top) continue;
    const t = wins[cat] ||= {}, k = top[0].toLowerCase();
    t[k] = { name: top[0], n: (t[k]?.n || 0) + 1 };
    lines.push(LABELS[cat].emoji + " **" + LABELS[cat].title + " (most voted):** " + top[0] + " · " + top[1] + " 👍");
  }
  posted.lastFood = pickLast.food?.name || prev.lists?.food?.[0]?.[0] || null;
  const allTime = Object.entries(wins).map(([cat, t]) => LABELS[cat].emoji + " " +
    Object.values(t).sort((a, b) => b.n - a.n).slice(0, 3).map(x => x.name + " (" + x.n + ")").join(", ")).join("\n");
  const winCh = chan("wheel-winners");
  if (winCh && lines.length) await say(winCh, { title: "🏆 Last week's winners", description: lines.join("\n") + "\n\n**All-time wins**\n" + allTime });
  posted.winners = wk;
}

// Clip of the week: Sunday, repost the #fan-clips post with the most reactions.
const clipCh = chan("fan-clips");
if (etDay === 0 && clipCh && posted.clip !== wk) {
  const msgs = await api("/channels/" + clipCh + "/messages?limit=100").catch(() => []);
  const best = msgs.filter(m => !m.author.bot && new Date(m.timestamp) >= since)
    .map(m => [m, (m.reactions || []).reduce((n, r) => n + r.count, 0)]).sort((a, b) => b[1] - a[1])[0];
  if (best?.[1]) await say(clipCh, { title: "🎬 Clip of the week", description: "<@" + best[0].author.id + "> with **" + best[1] + "** reactions\n[Watch it](" + msgLink(clipCh, best[0].id) + ")\n\nReact to clips all week. Most reactions wins on Sunday." });
  posted.clip = wk;
}

// Food score: after Wednesday's stream, ask for a 1-10 rating; post the average Friday.
const RATE = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const rateCh = chan("general-food-reviews");
const food = posted.lastFood ? "**" + posted.lastFood + "**" : "this week's food";
if (rateCh && etDay === 3 && etNow.getHours() >= 19 && posted.rate?.wk !== wk) {
  const m = await api("/channels/" + rateCh + "/messages", "POST", { embeds: [{ color: COLOR, title: "⭐ Rate tonight's food", description: "How was " + food + "? Tap a number below, 1 to 10. Score posts Friday." }] })
    .catch(e => console.warn("::warning::Couldn't post rating: " + e.message));
  if (m) {
    for (const e of RATE) await api("/channels/" + rateCh + "/messages/" + m.id + "/reactions/" + encodeURIComponent(e) + "/@me", "PUT").catch(() => null);
    posted.rate = { wk, id: m.id };
  }
}
if (rateCh && posted.rate?.wk === wk && !posted.rate.done && etDay >= 5) {
  const m = await api("/channels/" + rateCh + "/messages/" + posted.rate.id).catch(() => null);
  let votes = 0, sum = 0;
  for (const r of m?.reactions || []) {
    const i = RATE.indexOf(r.emoji.name), n = r.count - (r.me ? 1 : 0);
    if (i >= 0 && n > 0) { votes += n; sum += n * (i + 1); }
  }
  if (m) await say(rateCh, { title: "⭐ Food score: " + (votes ? (sum / votes).toFixed(1) + "/10" : "no votes"), description: food + " · " + votes + " vote" + (votes === 1 ? "" : "s") + "\n[See the votes](" + msgLink(rateCh, m.id) + ")" });
  posted.rate = { ...posted.rate, done: true };
}

// Gym check-ins: one post in #gym-progress per week keeps a streak going.
const gym = JSON.parse(JSON.stringify(prev.gym || {}));
const gymCh = chan("gym-progress"), lastWk = new Date(since - 7 * 86400000).toISOString();
if (gymCh) {
  const msgs = await api("/channels/" + gymCh + "/messages?limit=100").catch(e => (console.warn("::warning::Can't read gym channel: " + e.message), []));
  for (const m of msgs) {
    if (m.author.bot || new Date(m.timestamp) < since) continue;
    const g = gym[m.author.id] ||= { last: null, streak: 0 };
    if (g.last !== wk) { g.streak = g.last === lastWk ? g.streak + 1 : 1; g.last = wk; }
  }
  const live = Object.entries(gym).filter(([, g]) => g.last === wk || g.last === lastWk).sort((a, b) => b[1].streak - a[1].streak).slice(0, 20);
  await keep("gym_card", gymCh, {
    color: COLOR,
    title: "🏋️ Gym check-ins",
    description: [
      "📸 **Check in:** post your workout here. Once a week is enough.",
      "🔥 **Streak:** weeks in a row you checked in",
      "",
      "**Streaks**",
      live.length ? live.map(([id, g], i) => (i + 1) + ". <@" + id + "> · " + g.streak + " wk" + (g.last === wk ? " ✅" : "")).join("\n") : "No check-ins yet. Be the first!",
      "",
      "✅ = checked in this week. Week resets <t:" + resetAt + ":R>",
    ].join("\n"),
    footer: { text: "Wheel Sync · updates every 5 minutes" },
  });
}

const next = { weekStart: since.toISOString(), lists, boards, posted, wins, gym };
if (JSON.stringify({ weekStart: prev.weekStart, lists: prev.lists, boards: prev.boards, posted: prev.posted || {}, wins: prev.wins || {}, gym: prev.gym || {} }) === JSON.stringify(next)) {
  console.log("no change");
} else {
  fs.writeFileSync("data.json", JSON.stringify({ ...next, updated: new Date().toISOString() }, null, 1) + "\n");
  console.log("updated", Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length])));
}
