// Reads this week's suggestions from Discord and writes data.json for the wheel.
// A suggestion is one message; its votes are the people who reacted to it, with any emoji.
import { parseDay, dayName, welcomeCard, form, CHANNELS, RESET_HOUR, toET, weekStart, SUGGEST_FROM, suggester } from "./lib.mjs";
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error("DISCORD_TOKEN secret is missing"); process.exit(1); }
// XP, birthdays, streaks and role picks are kept in state.enc, encrypted with this
// key, because the repo is public. data.json only holds what the wheel page shows.
const crypto = await import("node:crypto");
const KEY = Buffer.from(process.env.STATE_KEY || "", "base64");
if (KEY.length !== 32) { console.error("STATE_KEY secret is missing or not 32 bytes"); process.exit(1); }
function seal(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64") + "\n";
}
function unseal(text) {
  const b = Buffer.from(text, "base64"), d = crypto.createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
}

// Plain suggestion channels: the card becomes a short how-to, no wheel or votes.
const PLAIN = { music: "1562529917546274817", anime: "1565113335324614656" };

const GUILD = "1533847576619520082";


async function api(path, method = "GET", body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch("https://discord.com/api/v10" + path, {
      method,
      headers: { Authorization: "Bot " + TOKEN, ...(body && !(body instanceof FormData) && { "Content-Type": "application/json" }) },
      body: body instanceof FormData ? body : body && JSON.stringify(body),
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

const me = await api("/users/@me");
async function reactors(path) {
  const out = [];
  for (let after = ""; ;) {
    const page = await api(path + "?limit=100" + after);
    out.push(...page);
    if (page.length < 100) return out;
    after = "&after=" + page[page.length - 1].id;
  }
}
// Carl-bot posts suggestions for people; the person is in the embed's author.
function carlAuthor(m) {
  const a = m.embeds?.[0]?.author;
  return a?.icon_url?.match(/avatars\/(\d+)\//)?.[1] || (a?.name ? "name:" + a.name.toLowerCase() : null);
}

async function channelEntries(id, since) {
  const raw = [];
  let before = "";
  for (let page = 0; page < 10; page++) {
    const msgs = await api(`/channels/${id}/messages?limit=100${before}`);
    if (!msgs.length) break;
    for (const m of msgs) {
      if (new Date(m.timestamp) < since) return oneEach(raw);
      // Pinned posts are the how-to and the weekly list, not suggestions.
      if (m.pinned) continue;
      const name = entryName(m);
      if (!name) continue;
      // Our own posts are nudges. Other bot posts without reactions are setup or
      // system messages; Carl-bot suggestions always carry its own reaction.
      // From SUGGEST_FROM on, only /suggest posts count, so people can chat here.
      const via = m.author.id === me.id && suggester(m);
      if (new Date(m.timestamp) >= SUGGEST_FROM ? !via : m.author.id === me.id || (m.author.bot && !m.reactions?.length)) continue;
      const who = new Set();
      for (const r of m.reactions || []) {
        const e = encodeURIComponent(r.emoji.id ? r.emoji.name + ":" + r.emoji.id : r.emoji.name);
        const users = await reactors(`/channels/${id}/messages/${m.id}/reactions/${e}`).catch(err => (console.warn("::warning::Couldn't read votes: " + err.message), []));
        for (const u of users) if (!u.bot) who.add(u.id);
      }
      // A bot suggestion with no person behind it can't be held to one each.
      const author = via || (m.author.bot ? carlAuthor(m) : m.author.id);
      if (!author) continue;
      raw.push({ name, ch: id, id: m.id, author, reactors: who, link: `https://discord.com/channels/${GUILD}/${id}/${m.id}` });
    }
    before = "&before=" + msgs[msgs.length - 1].id;
  }
  return oneEach(raw);
}

// One per person per week: your first suggestion (which is your vote) or one
// vote. Later suggestions are dropped, and a suggester's reactions don't count.
// Reactions have no time, so someone who reacts to several counts on the oldest.
const extras = [];
function oneEach(raw) {
  raw.reverse();
  const suggesters = new Set(), counted = new Set();
  const kept = raw.filter(e => {
    if (!suggesters.has(e.author)) return suggesters.add(e.author);
    extras.push(e);
  });
  for (const e of kept) counted.add(e.author);
  return kept.map(e => {
    let n = 1;
    for (const u of e.reactors) if (!suggesters.has(u) && !counted.has(u)) { counted.add(u); n++; }
    return [e.name, n, e.link];
  });
}

const since = weekStart();
// The reset moved from Monday 00:00 to Tuesday 9 PM mid-week. Keep that week's
// Monday and Tuesday suggestions; this does nothing after Oct 27 2026.
const listFrom = new Date(Math.min(since, Date.parse("2026-10-19T04:00:00Z")));
const lists = {};
for (const [cat, id] of Object.entries(CHANNELS)) {
  if (!id) continue;
  const merged = new Map();
  for (const [name, v, link] of await channelEntries(id, listFrom)) {
    const k = name.toLowerCase();
    const cur = merged.get(k);
    // Repeats add their votes to the first post, which keeps the link.
    merged.set(k, cur ? [cur[0], cur[1] + v, cur[2]] : [name, v, link]);
  }
  lists[cat] = [...merged.values()].sort((a, b) => b[1] - a[1]).slice(0, 40);
}

const fs = await import("node:fs");
let prev = {};
// A state.enc that won't open stops the run instead of starting over from nothing.
if (fs.existsSync("state.enc")) prev = unseal(fs.readFileSync("state.enc", "utf8"));
else try { prev = JSON.parse(fs.readFileSync("data.json", "utf8")); } catch {}

// The bot keeps one card per channel, edited in place: short how-to on top,
// this week's list with jump links below. Pin it once in Discord.
const COLOR = 0xe2552e;
const LABELS = {
  food: { title: "Food", noun: "food", emoji: "🍕" },
  games: { title: "Game", noun: "game", emoji: "🎮" },
  music: { title: "Song", noun: "song", emoji: "🎵" },
  anime: { title: "Anime", noun: "anime", emoji: "📺" },
  gym: { title: "Gym", noun: "gym challenge", emoji: "🏋️" },
};
// Extra channels are found by name so emoji prefixes don't matter.
const guildChannels = await api("/guilds/" + GUILD + "/channels").catch(() => []);
const chan = part => guildChannels.find(c => c.type === 0 && c.name.includes(part))?.id;
const msgLink = (ch, id) => "https://discord.com/channels/" + GUILD + "/" + ch + "/" + id;

// Wheel picks: the wheel page's "Post to #announcements" message names the winner.
// Newest post per category wins, so a re-spin just needs a new post, and deleting
// the post clears the pick. Posts in the first 24 hours after the reset count for
// the week before, so Wednesday's spin lands on the week that was voted on.
const TITLES = { "Food Review Wednesday": "food", "Game of the week": "games", "Song of the week": "music", "Gym challenge": "gym" };
const GRACE = 24 * 3600000, lastWkStart = new Date(since - 7 * 86400000).toISOString();
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
      "☝️ **One each week:** suggest one or vote for one, not both",
      "👍 **Vote:** react to one name below with any emoji. React to more than one and only the oldest counts",
      "✍️ **Suggest:** use `/suggest` in this channel. It counts as your vote. Chat here freely; only /suggest posts go on the wheel",
      "🎡 **Win:** most votes gets the biggest slice. Dennis spins at the end of the week.",
      "",
      ...(pickNow[cat] ? ["🎡 **Wheel pick:** [" + pickNow[cat].name.replace(/[[\]]/g, "") + "](" + pickNow[cat].link + ")", ""] : []),
      "**This week**",
      it.length ? body.trim() : "Nothing yet. Be the first!",
      "",
      "Resets <t:" + resetAt + ":R>",
    ].join("\n"),
    footer: { text: "DRC Bot" },
  };
}
// When chat pushes the card more than BURY messages up, repost it at the bottom.
const BURY = 20;
async function keep(key, channel, embed) {
  const text = JSON.stringify(embed), old = boards[key];
  const recent = old?.id ? await api("/channels/" + channel + "/messages?limit=" + BURY).catch(() => null) : null;
  const buried = recent?.length === BURY && !recent.some(m => m.id === old.id);
  if (old && old.text === text && !buried) return;
  const body = { content: "", embeds: [embed] };
  try {
    let msg = null;
    if (buried) await api("/channels/" + channel + "/messages/" + old.id, "DELETE").catch(() => null);
    else if (old?.id) msg = await api("/channels/" + channel + "/messages/" + old.id, "PATCH", body).catch(() => null);
    // An edit that comes back without the embed is useless; post a new card.
    if (!msg?.embeds?.length) {
      msg = await api("/channels/" + channel + "/messages", "POST", body);
      await api("/channels/" + channel + "/pins/" + msg.id, "PUT").catch(e => console.warn("::warning::Couldn't pin " + key + ": " + e.message));
    }
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
for (const [cat, id] of Object.entries(PLAIN)) {
  await keep(cat + "_card", id, {
    color: COLOR,
    title: LABELS[cat].emoji + " " + LABELS[cat].title + " suggestions",
    description: (cat === "anime" ? "Got an " : "Got a ") + LABELS[cat].noun + " Dennis should check out? Post it here. React to the ones you like.",
  });
}
// One post per channel when the week flips, and a last call Tuesday noon (ET),
// nine hours before the reset.
const posted = { ...(prev.posted || {}) }, wk = since.toISOString();
// A week start less than 6 days after the last one is the schedule change, not a
// new week: carry this week's posts over instead of announcing a reset.
const moved = prev.weekStart && since - new Date(prev.weekStart) < 6 * 86400000;
if (moved) for (const [k, v] of Object.entries(posted)) {
  if (v === prev.weekStart) posted[k] = wk;
  else if (v?.wk === prev.weekStart) posted[k] = { ...v, wk };
}
const flipped = prev.weekStart && prev.weekStart !== wk && !moved;
if (flipped) posted.lastLists = { wk, lists: prev.lists || {} };
const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
const etDay = etNow.getDay();
async function say(channel, embed) {
  await api("/channels/" + channel + "/messages", "POST", { embeds: [{ color: COLOR, ...embed }] })
    .catch(e => console.warn("::warning::Couldn't post nudge: " + e.message));
}
if (flipped && posted.reset !== wk) {
  for (const [cat, id] of Object.entries(CHANNELS)) if (id)
    await say(id, { title: "🔄 New week, fresh " + LABELS[cat].noun + " wheel", description: "Last week's list is cleared. Use /suggest here to add a " + LABELS[cat].noun + ", and check the pinned card to vote." });
  posted.reset = wk;
}
// Tell people once when a post won't count. Only this week's posts are kept.
const told = new Set(posted.extra || []);
const toldWho = new Set(posted.extraWho?.wk === wk ? posted.extraWho.ids : []);
for (const e of extras) if (!told.has(e.id)) {
  told.add(e.id);
  if (toldWho.has(e.author)) continue;
  toldWho.add(e.author);
  await api("/channels/" + e.ch + "/messages", "POST", {
    content: "You already have a suggestion this week, so this one won't count. Only your first one does. I'll only say this once a week.",
    message_reference: { message_id: e.id, fail_if_not_exists: false },
    allowed_mentions: { parse: [], replied_user: false },
  }).catch(err => console.warn("::warning::Couldn't reply to extra: " + err.message));
}
posted.extra = extras.map(e => e.id).filter(id => told.has(id));
posted.extraWho = { wk, ids: [...toldWho] };
if (etDay === 2 && etNow.getHours() >= 12 && etNow.getHours() < RESET_HOUR && posted.lastCallTue !== wk) {
  for (const [cat, id] of Object.entries(CHANNELS)) {
    if (!id) continue;
    const top = lists[cat].slice(0, 3).map(([n, v, link], i) => ["🥇", "🥈", "🥉"][i] + " [" + n.replace(/[[\]]/g, "") + "](" + link + ") · " + v + " 👍").join("\n");
    await say(id, { title: "⏰ Last call for " + LABELS[cat].noun + " votes", description: (top || "Nothing suggested yet. There's still time!") + "\n\nThe wheel spins soon. React to your favorite with any emoji." });
  }
  posted.lastCallTue = wk;
}
// Winner history: when the week flips, post last week's most voted and an all-time tally.
const wins = JSON.parse(JSON.stringify(prev.wins || {}));
if (posted.lastLists?.wk === wk && posted.winners !== wk && Date.now() - since >= GRACE) {
  const lines = [];
  for (const cat of Object.keys(CHANNELS)) {
    const top = posted.lastLists.lists[cat]?.[0], pick = pickLast[cat];
    if (pick) lines.push(LABELS[cat].emoji + " **" + LABELS[cat].title + " (wheel):** [" + pick.name + "](" + pick.link + ")");
    if (!top) continue;
    const t = wins[cat] ||= {}, k = top[0].toLowerCase();
    t[k] = { name: top[0], n: (t[k]?.n || 0) + 1 };
    lines.push(LABELS[cat].emoji + " **" + LABELS[cat].title + " (most voted):** " + top[0] + " · " + top[1] + " 👍");
  }
  posted.lastFood = pickLast.food?.name || posted.lastLists.lists.food?.[0]?.[0] || null;
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
  const scored = [];
  for (const m of msgs.filter(m => !m.author.bot && new Date(m.timestamp) >= since && m.reactions?.length)) {
    const who = new Set();
    for (const r of m.reactions) {
      const e = encodeURIComponent(r.emoji.id ? r.emoji.name + ":" + r.emoji.id : r.emoji.name);
      for (const u of await reactors("/channels/" + clipCh + "/messages/" + m.id + "/reactions/" + e).catch(() => []))
        if (!u.bot && u.id !== m.author.id) who.add(u.id);
    }
    scored.push([m, who.size]);
  }
  const best = scored.sort((a, b) => b[1] - a[1])[0];
  if (best?.[1]) await say(clipCh, { title: "🎬 Clip of the week", description: "<@" + best[0].author.id + "> with **" + best[1] + "** " + (best[1] === 1 ? "person" : "people") + " reacting\n[Watch it](" + msgLink(clipCh, best[0].id) + ")\n\nReact to clips all week. The clip the most people react to wins on Sunday." });
  posted.clip = wk;
}

// Food score: after Wednesday's stream, ask for a 1-10 rating; post the average Friday.
const RATE = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const rateCh = chan("general-food-reviews");
const foodName = pickLast.food?.name || posted.lastFood;
const food = foodName ? "**" + foodName + "**" : "this week's food";
if (rateCh && etDay === 3 && etNow.getHours() >= 19 && posted.rate?.wk !== wk) {
  const m = await api("/channels/" + rateCh + "/messages", "POST", { embeds: [{ color: COLOR, title: "⭐ Rate tonight's food", description: "How was " + food + "? Tap one number below, 1 to 10. Tap more than one and your vote won't count. Score posts Friday." }] })
    .catch(e => console.warn("::warning::Couldn't post rating: " + e.message));
  if (m) {
    for (const e of RATE) await api("/channels/" + rateCh + "/messages/" + m.id + "/reactions/" + encodeURIComponent(e) + "/@me", "PUT").catch(() => null);
    posted.rate = { wk, id: m.id };
  }
}
if (rateCh && posted.rate?.wk === wk && !posted.rate.done && etDay >= 5) {
  const m = await api("/channels/" + rateCh + "/messages/" + posted.rate.id).catch(() => null);
  let votes = 0, sum = 0;
  const pickedBy = {};
  for (const r of m?.reactions || []) {
    const i = RATE.indexOf(r.emoji.name);
    if (i < 0) continue;
    for (const u of await reactors("/channels/" + rateCh + "/messages/" + m.id + "/reactions/" + encodeURIComponent(r.emoji.name)).catch(() => []))
      if (!u.bot) (pickedBy[u.id] ||= []).push(i + 1);
  }
  for (const n of Object.values(pickedBy)) if (n.length === 1) { votes++; sum += n[0]; }
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
    footer: { text: "DRC Bot" },
  });
}

// Live alert: one post in #live-alerts per stream. Uses a Twitch app's keys,
// not Dennis's login. Skipped until TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are set.
const TWITCH_LOGIN = "everythingdrc";
const liveCh = chan("live-alerts");
if (liveCh && process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) {
  try {
    const id = process.env.TWITCH_CLIENT_ID;
    const auth = await fetch("https://id.twitch.tv/oauth2/token?client_id=" + id + "&client_secret=" + process.env.TWITCH_CLIENT_SECRET + "&grant_type=client_credentials", { method: "POST" });
    if (!auth.ok) throw new Error("token " + auth.status);
    const r = await fetch("https://api.twitch.tv/helix/streams?user_login=" + TWITCH_LOGIN, {
      headers: { "Client-Id": id, Authorization: "Bearer " + (await auth.json()).access_token },
    });
    if (!r.ok) throw new Error("streams " + r.status);
    const stream = (await r.json()).data?.[0];
    const restart = posted.liveAt && Date.now() - posted.liveAt < 30 * 60000;
    if (stream && posted.live !== stream.id && restart) posted.live = stream.id;
    if (stream) posted.liveAt = Date.now();
    if (stream && posted.live !== stream.id) {
      const url = "https://twitch.tv/" + TWITCH_LOGIN;
      await api("/channels/" + liveCh + "/messages", "POST", {
        content: "@everyone Dennis is live!",
        allowed_mentions: { parse: ["everyone"] },
        embeds: [{
          color: COLOR,
          title: stream.title || "Live on Twitch",
          url,
          description: (stream.game_name ? "Playing **" + stream.game_name + "**\n" : "") + "[Watch on Twitch](" + url + ")",
          image: { url: stream.thumbnail_url.replace("{width}", "1280").replace("{height}", "720") + "?t=" + Date.now() },
        }],
      });
      posted.live = stream.id;
    }
  } catch (e) {
    console.warn("::warning::Live check failed: " + e.message);
  }
}

// Levels, MEE6 style: 15-25 XP per message, at most once a minute per person.
// MEE6 XP was carried over once (Oct 2026). History is not counted, only messages after the
// first run. Level-ups go to #level-ups; Regular at 5, Veteran at 15.
const REWARDS = { 5: "Regular", 15: "Veteran" };
const need = l => 5 * l * l + 50 * l + 100;
function levelOf(xp) { let l = 0; while (xp >= need(l)) xp -= need(l++); return l; }
const levels = JSON.parse(JSON.stringify(prev.levels || {}));
levels.users ||= {};
levels.last ||= {};
const noxp = levels.noxp || { channels: [], roles: [] };
const rolesOf = {};
const lvCh = chan("level-ups");
let guildRoles = null;
for (const c of guildChannels.filter(c => c.type === 0)) {
  const after = levels.last[c.id];
  const msgs = await api("/channels/" + c.id + "/messages?limit=100" + (after ? "&after=" + after : "")).catch(() => []);
  if (!msgs.length) continue;
  levels.last[c.id] = msgs[0].id;
  // First sight of a channel only marks where to start.
  if (!after) continue;
  if (noxp.channels.includes(c.id) || noxp.channels.includes(c.parent_id)) continue;
  for (const m of msgs.reverse()) {
    if (m.author.bot || m.webhook_id) continue;
    if (noxp.roles.length) {
      rolesOf[m.author.id] ||= (await api("/guilds/" + GUILD + "/members/" + m.author.id).catch(() => null))?.roles || [];
      if (rolesOf[m.author.id].some(r => noxp.roles.includes(r))) continue;
    }
    const u = levels.users[m.author.id] ||= { xp: 0, msgs: 0, at: 0 };
    const t = Date.parse(m.timestamp);
    u.msgs++;
    if (t - u.at < 60000) continue;
    const before = levelOf(u.xp);
    u.xp += 15 + Math.floor(Math.random() * 11);
    u.at = t;
    const now = levelOf(u.xp);
    if (now <= before) continue;
    if (lvCh) await api("/channels/" + lvCh + "/messages", "POST", {
      content: "GG <@" + m.author.id + ">, you just advanced to level " + now + "!",
      allowed_mentions: { users: [m.author.id] },
    }).catch(e => console.warn("::warning::Couldn't post level-up: " + e.message));
    for (const [lvl, name] of Object.entries(REWARDS)) {
      if (now < +lvl || before >= +lvl) continue;
      guildRoles ||= await api("/guilds/" + GUILD + "/roles").catch(() => []);
      const role = guildRoles.find(r => r.name === name);
      if (role) await api("/guilds/" + GUILD + "/members/" + m.author.id + "/roles/" + role.id, "PUT")
        .catch(e => console.warn("::warning::Couldn't give " + name + ": " + e.message));
    }
  }
}
// After /xp, bring level roles in line with the new level, up or down.
for (const [id, u] of Object.entries(levels.users)) {
  if (!u.fix) continue;
  delete u.fix;
  guildRoles ||= await api("/guilds/" + GUILD + "/roles").catch(() => []);
  for (const [lvl, name] of Object.entries(REWARDS)) {
    const role = guildRoles.find(r => r.name === name);
    if (role) await api("/guilds/" + GUILD + "/members/" + id + "/roles/" + role.id, levelOf(u.xp) >= +lvl ? "PUT" : "DELETE")
      .catch(e => console.warn("::warning::Couldn't update " + name + ": " + e.message));
  }
}

if (lvCh) {
  const top = Object.entries(levels.users).sort((a, b) => b[1].xp - a[1].xp).slice(0, 10);
  await keep("lv_card", lvCh, {
    color: COLOR,
    title: "⬆️ Leaderboard",
    description: [
      "💬 **Earn XP:** chat anywhere. One message a minute counts.",
      "🏅 **Rewards:** Regular at level 5, Veteran at level 15",
      "",
      top.length ? top.map(([id, u], i) => (i + 1) + ". <@" + id + "> · level " + levelOf(u.xp) + " · " + u.xp + " XP").join("\n") : "No XP yet. Say something!",
    ].join("\n"),
    footer: { text: "DRC Bot" },
  });
}

// Reaction roles in #roles: react to get a role, remove the reaction to drop it.
// Only roles given here are taken back here; onboarding roles are left alone.
const RR = [
  ["🙌", "Viewer", "you watch the streams"],
  ["🍕", "Food Critic", "you post food reviews"],
  ["🏋️", "Gym Rat", "gym pings and challenges"],
  ["🕹️", "Collector", "game collection talk"],
  ["🎮", "Gamer", "game nights and game of the week"],
  ["🎵", "Music Fan", "song of the week"],
];
let rr = JSON.parse(JSON.stringify(prev.rr || {}));
const rolesCh = chan("roles");
if (rolesCh) {
  await keep("rr_card", rolesCh, {
    color: COLOR,
    title: "🎭 Pick your roles",
    description: "React to get a role. Remove your reaction to drop it.\n\n" + RR.map(([e, n, what]) => e + " **" + n + ":** " + what).join("\n"),
  });
  const id = boards.rr_card?.id;
  // A new card starts with no reactions; don't read that as everyone leaving.
  if (id && rr.msg !== id) rr = { msg: id };
  if (id) {
    guildRoles ||= await api("/guilds/" + GUILD + "/roles").catch(() => []);
    for (const [e, name] of RR) {
      const role = guildRoles.find(r => r.name === name);
      const path = "/channels/" + rolesCh + "/messages/" + id + "/reactions/" + encodeURIComponent(e);
      const users = role && await reactors(path).catch(() => null);
      if (!users) continue;
      if (!users.some(u => u.id === me.id)) await api(path + "/@me", "PUT").catch(() => null);
      const now = users.filter(u => !u.bot).map(u => u.id), was = rr[name] || [];
      for (const u of now) if (!was.includes(u))
        await api("/guilds/" + GUILD + "/members/" + u + "/roles/" + role.id, "PUT").catch(err => console.warn("::warning::Couldn't give " + name + ": " + err.message));
      for (const u of was) if (!now.includes(u))
        await api("/guilds/" + GUILD + "/members/" + u + "/roles/" + role.id, "DELETE").catch(err => console.warn("::warning::Couldn't remove " + name + ": " + err.message));
      rr[name] = now;
    }
  }
}

// Welcome: answer Discord's own "joined the server" message with a short card.
const guild = await api("/guilds/" + GUILD + "?with_counts=true").catch(() => null);
const sysCh = guild?.system_channel_id;
// Discord posts its join notice in the system channel; the welcome goes to #welcome.
const welcomeCh = chan("welcome") || sysCh;
if (sysCh) {
  const msgs = await api("/channels/" + sysCh + "/messages?limit=50" + (posted.welcome ? "&after=" + posted.welcome : "")).catch(() => []);
  // Newest first; the first look only marks where to start.
  const newest = msgs[0]?.id;
  if (msgs.length && posted.welcome) {
    const link = part => chan(part) ? "<#" + chan(part) + ">" : "#" + part;
    for (const m of msgs.reverse()) {
      if (m.type !== 7) continue;
      const card = await welcomeCard({ user: m.author, count: guild.approximate_member_count }).catch(e => console.warn("::warning::Welcome card failed: " + e.message));
      const msg = {
        content: "Hey <@" + m.author.id + ">, welcome to **EverythingDRC**! Grab your roles in " + link("roles") + ", check " + link("schedule") + " for stream times. Come say hi in " + link("general") + "! 👋",
        allowed_mentions: { users: [m.author.id] },
        message_reference: welcomeCh === sysCh ? { message_id: m.id, fail_if_not_exists: false } : undefined,
        embeds: [{
          color: COLOR,
          title: (m.author.global_name || m.author.username) + " just joined the server",
          description: guild.approximate_member_count ? "Member #" + guild.approximate_member_count : undefined,
          thumbnail: m.author.avatar ? { url: "https://cdn.discordapp.com/avatars/" + m.author.id + "/" + m.author.avatar + ".png" } : undefined,
        }],
      };
      if (card) msg.embeds = [{ color: COLOR, image: { url: "attachment://welcome.png" } }];
      await api("/channels/" + welcomeCh + "/messages", "POST", card ? form(msg, "welcome.png", card) : msg)
        .catch(e => console.warn("::warning::Couldn't welcome: " + e.message));
    }
  }
  if (newest) posted.welcome = newest;
}

// Birthdays: post your date in #birthdays. Only month and day are kept. The bot
// reacts 🎂 when it understood, and wishes you happy birthday in #general.
const bdays = { ...(prev.bdays || {}) }, byear = { ...(prev.byear || {}) };
const nth = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
const bdayCh = chan("birthdays");
if (bdayCh) {
  const msgs = await api("/channels/" + bdayCh + "/messages?limit=100" + (posted.bdayLast ? "&after=" + posted.bdayLast : "")).catch(() => []);
  if (msgs[0]) posted.bdayLast = msgs[0].id;
  // Oldest first so a newer post replaces an older one.
  for (const m of msgs.reverse()) {
    if (m.author.bot) continue;
    if (m.content.length > 40 && !/birth|bday/i.test(m.content)) continue;
    const day = parseDay(m.content);
    if (!day) continue;
    bdays[m.author.id] = day;
    const yr = +m.content.match(/\b(19\d\d|20\d\d)\b/)?.[1];
    if (yr && yr <= etNow.getFullYear()) byear[m.author.id] = yr;
    if (!m.reactions?.some(r => r.me)) await api("/channels/" + bdayCh + "/messages/" + m.id + "/reactions/" + encodeURIComponent("🎂") + "/@me", "PUT").catch(() => null);
  }
  const today = String(etNow.getMonth() + 1).padStart(2, "0") + "-" + String(etNow.getDate()).padStart(2, "0");
  const genCh = chan("general");
  posted.bday ||= {};
  for (const [id, day] of Object.entries(bdays)) {
    if (day !== today || posted.bday[id] === etNow.getFullYear() || etNow.getHours() < 9 || !genCh) continue;
    const age = byear[id] && etNow.getFullYear() - byear[id];
    await api("/channels/" + genCh + "/messages", "POST", {
      content: "🎂 Happy " + (age ? nth(age) + " " : "") + "birthday <@" + id + ">!",
      allowed_mentions: { users: [id] },
    }).catch(e => console.warn("::warning::Couldn't post birthday: " + e.message));
    posted.bday[id] = etNow.getFullYear();
  }
  posted.bdayRole ||= {};
  const due = Object.keys(bdays).filter(id => bdays[id] === today && etNow.getHours() >= 9 && !posted.bdayRole[id]);
  const done = Object.keys(posted.bdayRole).filter(id => posted.bdayRole[id] !== today);
  if (due.length || done.length) {
    guildRoles ||= await api("/guilds/" + GUILD + "/roles").catch(() => []);
    let role = guildRoles.find(r => r.name === "Birthday");
    if (!role && due.length) role = await api("/guilds/" + GUILD + "/roles", "POST", { name: "Birthday", color: 0xe2552e, hoist: true })
      .catch(e => console.warn("::warning::Couldn't make Birthday role: " + e.message));
    for (const id of due) {
      if (role) await api("/guilds/" + GUILD + "/members/" + id + "/roles/" + role.id, "PUT").catch(e => console.warn("::warning::Couldn't give Birthday: " + e.message));
      posted.bdayRole[id] = today;
    }
    for (const id of done) {
      if (role) await api("/guilds/" + GUILD + "/members/" + id + "/roles/" + role.id, "DELETE").catch(() => null);
      delete posted.bdayRole[id];
    }
  }
  const key = d => (d < today ? "1" : "0") + d;
  const soon = Object.entries(bdays).sort((a, b) => key(a[1]).localeCompare(key(b[1]))).slice(0, 10);
  await keep("bday_card", bdayCh, {
    color: COLOR,
    title: "🎂 Birthdays",
    description: [
      "✍️ **Add yours:** use `/birthday set`, or post it here like `10/22` or `Oct 22`. Add a year only if you want your age in the shout-out.",
      "🎂 The bot reacts when it got a post. `/birthday remove` takes yours off.",
      "🎉 On the day you get a shout-out in " + (genCh ? "<#" + genCh + ">" : "#general") + " and the Birthday role.",
      "",
      "**Coming up**",
      soon.length ? soon.map(([id, d]) => dayName(d) + " · <@" + id + ">").join("\n") : "No birthdays yet. Add yours!",
    ].join("\n"),
    footer: { text: "DRC Bot" },
  });
}

const next = { weekStart: since.toISOString(), lists, boards, posted, wins, gym, levels, bdays, byear, rr };
const { updated: _, ...was } = prev;
if (fs.existsSync("state.enc") && JSON.stringify(was) === JSON.stringify(next)) {
  console.log("no change");
} else {
  const updated = new Date().toISOString();
  fs.writeFileSync("state.enc", seal({ ...next, updated }));
  fs.writeFileSync("data.json", JSON.stringify({ weekStart: next.weekStart, lists, updated }, null, 1) + "\n");
  console.log("updated", Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length])));
}
