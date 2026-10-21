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

// Week starts Monday 00:00 US Eastern.
function weekStart(now = new Date()) {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const offset = now - et;
  et.setHours(0, 0, 0, 0);
  et.setDate(et.getDate() - ((et.getDay() + 6) % 7));
  return new Date(Math.round((et.getTime() + offset) / 60000) * 60000);
}

async function api(path) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch("https://discord.com/api/v10" + path, { headers: { Authorization: "Bot " + TOKEN } });
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
      const name = entryName(m);
      if (!name) continue;
      const up = m.reactions?.find(r => r.emoji.name === "👍")?.count || 0;
      // Bots that auto-react (Carl-bot) add one 👍 of their own.
      out.push([name, Math.max(0, m.author.bot ? up - 1 : up)]);
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
  for (const [name, v] of await channelEntries(id, since)) {
    const k = name.toLowerCase();
    const cur = merged.get(k);
    merged.set(k, cur ? [cur[0], cur[1] + v] : [name, v]);
  }
  lists[cat] = [...merged.values()].sort((a, b) => b[1] - a[1]).slice(0, 40);
}

const fs = await import("node:fs");
const next = { weekStart: since.toISOString(), lists };
let prev = {};
try { prev = JSON.parse(fs.readFileSync("data.json", "utf8")); } catch {}
if (JSON.stringify({ weekStart: prev.weekStart, lists: prev.lists }) === JSON.stringify(next)) {
  console.log("no change");
} else {
  fs.writeFileSync("data.json", JSON.stringify({ ...next, updated: new Date().toISOString() }, null, 1) + "\n");
  console.log("updated", Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length])));
}
