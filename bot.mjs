// Always-on DRC Bot. Runs on the Oracle server under systemd (drc-bot.service).
// Keeps a gateway connection so messages, joins and reactions trigger sync.mjs
// within seconds instead of every 2 minutes, and answers slash commands.
// sync.mjs still does all the work; this file only decides when to run it.
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { parseDay, dayName, rankCard, form } from "./lib.mjs";

const TOKEN = process.env.DISCORD_TOKEN;
const KEY = Buffer.from(process.env.STATE_KEY || "", "base64");
const GUILD = "1533847576619520082";
if (!TOKEN || KEY.length !== 32) { console.error("DISCORD_TOKEN or STATE_KEY missing"); process.exit(1); }

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

function state() {
  const b = Buffer.from(fs.readFileSync("state.enc", "utf8"), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
}
function save(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  fs.writeFileSync("state.enc", Buffer.concat([iv, c.getAuthTag(), body]).toString("base64") + "\n");
}
// Edits from admin and birthday commands wait here until the next run, so they
// land between git pull and sync.mjs instead of racing them.
const edits = [];
const reply = (i, content) => api("/webhooks/" + i.application_id + "/" + i.token + "/messages/@original", "PATCH", { content, allowed_mentions: { parse: [] } })
  .catch(e => console.warn("reply failed: " + e.message));

// Sync runs one at a time. kick() asks for a run soon; the timer covers the
// wheel and Twitch when nothing is happening.
let running = false, again = false, timer = null;
function kick(ms = 3000) {
  clearTimeout(timer);
  timer = setTimeout(run, ms);
}
async function run() {
  clearTimeout(timer);
  if (running) { again = true; return; }
  running = true;
  try {
    const git = (...a) => execFileSync("git", a, { stdio: "pipe" }).toString();
    try { git("pull", "-q", "--rebase"); } catch (e) { console.warn("pull failed: " + e.message); }
    if (edits.length) {
      const s = state(), done = edits.splice(0);
      const out = done.map(({ fn }) => { try { return fn(s); } catch (e) { return "That didn't work: " + e.message; } });
      save(s);
      done.forEach(({ i }, n) => reply(i, out[n]));
    }
    await new Promise(done => spawn("node", ["sync.mjs"], { stdio: "inherit" }).on("exit", done));
    if (git("status", "--porcelain", "data.json", "state.enc").trim()) {
      git("add", "data.json", "state.enc");
      git("commit", "-qm", "sync wheel entries");
      try { git("pull", "-q", "--rebase"); git("push", "-q"); } catch (e) { console.warn("push failed: " + e.message); }
    }
  } catch (e) {
    console.warn("run failed: " + e.message);
  }
  running = false;
  if (again) { again = false; kick(1000); } else kick(120000);
}

// Slash commands, MEE6 style.
const need = l => 5 * l * l + 50 * l + 100;
function progress(xp) { let l = 0; while (xp >= need(l)) xp -= need(l++); return { level: l, into: xp, next: need(l) }; }
const member = { type: 6, name: "member", description: "Who", required: true };
const amount = { type: 4, name: "amount", description: "How much XP", required: true, min_value: 0, max_value: 1000000 };
const COMMANDS = [
  { name: "rank", description: "Show your level and XP", options: [{ type: 6, name: "member", description: "Someone else's rank" }] },
  { name: "leaderboard", description: "Top 10 by XP" },
  { name: "xp", description: "Change someone's XP", default_member_permissions: "32", options: [
    { type: 1, name: "add", description: "Give XP", options: [member, amount] },
    { type: 1, name: "remove", description: "Take XP away", options: [member, amount] },
    { type: 1, name: "set", description: "Set XP to an exact number", options: [member, amount] },
    { type: 1, name: "reset", description: "Set XP to 0", options: [member] },
  ] },
  { name: "noxp", description: "Channels and roles that don't earn XP", default_member_permissions: "32", options: [
    { type: 1, name: "channel", description: "Turn XP off or back on in a channel or category", options: [{ type: 7, name: "channel", description: "Channel or category", required: true }] },
    { type: 1, name: "role", description: "Turn XP off or back on for a role", options: [{ type: 8, name: "role", description: "Role", required: true }] },
    { type: 1, name: "list", description: "Show what doesn't earn XP" },
  ] },
  { name: "birthday", description: "Birthday shout-outs", options: [
    { type: 1, name: "set", description: "Save your birthday", options: [
      { type: 3, name: "date", description: "Like 10/22 or Oct 22", required: true },
      { type: 4, name: "year", description: "Optional. Only if you want your age in the shout-out", min_value: 1900, max_value: new Date().getFullYear() },
    ] },
    { type: 1, name: "remove", description: "Forget your birthday" },
    { type: 1, name: "next", description: "Upcoming birthdays" },
  ] },
];
const callback = (i, body) => api("/interactions/" + i.id + "/" + i.token + "/callback", "POST", body);
async function answer(i) {
  const name = i.data.name, sub = i.data.options?.[0], opt = n => sub?.options?.find(o => o.name === n)?.value;
  const self = i.member.user.id;
  if (name === "xp" || (name === "noxp" && sub.name !== "list") || (name === "birthday" && sub.name !== "next")) {
    await callback(i, { type: 5, data: { flags: 64 } });
    edits.push({ i, fn: s => change(s, name, sub.name, opt, self, i.data.resolved) });
    return kick(0);
  }
  const s = state(), users = s.levels?.users || {};
  const ranked = Object.entries(users).sort((a, b) => b[1].xp - a[1].xp);
  let content;
  if (name === "rank") {
    const id = i.data.options?.[0]?.value || self;
    const u = users[id], at = ranked.findIndex(([k]) => k === id);
    if (!u) content = "<@" + id + "> has no XP yet. Chat to earn some.";
    else {
      await callback(i, { type: 5 });
      const user = i.data.resolved?.users?.[id] || i.member.user;
      const p = progress(u.xp);
      const card = await rankCard({ user, rank: at + 1, level: p.level, into: p.into, next: p.next, xp: u.xp }).catch(e => console.warn("rank card: " + e.message));
      const text = "<@" + id + "> · rank #" + (at + 1) + " · level " + p.level + " · " + p.into + "/" + p.next + " XP to level " + (p.level + 1);
      const path = "/webhooks/" + i.application_id + "/" + i.token + "/messages/@original";
      return api(path, "PATCH", card ? form({ allowed_mentions: { parse: [] } }, "rank.png", card) : { content: text, allowed_mentions: { parse: [] } });
    }
  } else if (name === "noxp") {
    const n = s.levels?.noxp || { channels: [], roles: [] };
    content = n.channels.length || n.roles.length
      ? "**No XP in:** " + (n.channels.map(c => "<#" + c + ">").join(", ") || "none") + "\n**No XP for:** " + (n.roles.map(r => "<@&" + r + ">").join(", ") || "none")
      : "Every channel and role earns XP. Use `/noxp channel` or `/noxp role` to turn it off somewhere.";
  } else if (name === "birthday") {
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const t = String(et.getMonth() + 1).padStart(2, "0") + "-" + String(et.getDate()).padStart(2, "0");
    const key = d => (d < t ? "1" : "0") + d;
    const soon = Object.entries(s.bdays || {}).sort((a, b) => key(a[1]).localeCompare(key(b[1]))).slice(0, 5);
    content = soon.length ? "**Coming up**\n" + soon.map(([id, d]) => dayName(d) + " · <@" + id + ">").join("\n") : "No birthdays yet. Add yours with `/birthday set`.";
  } else {
    content = ranked.length
      ? "**Leaderboard**\n" + ranked.slice(0, 10).map(([id, u], n) => (n + 1) + ". <@" + id + "> · level " + progress(u.xp).level + " · " + u.xp + " XP").join("\n")
      : "No XP yet. Say something!";
  }
  await callback(i, { type: 4, data: { content, allowed_mentions: { parse: [] } } });
}

// Runs inside run() on the unsealed state. Returns the reply text.
function change(s, name, sub, opt, self, resolved) {
  if (name === "xp") {
    const id = opt("member"), n = opt("amount") || 0;
    if (resolved?.users?.[id]?.bot) return "Bots don't earn XP.";
    s.levels ||= {}; s.levels.users ||= {};
    const u = s.levels.users[id] ||= { xp: 0, msgs: 0, at: 0 };
    u.xp = Math.max(0, sub === "add" ? u.xp + n : sub === "remove" ? u.xp - n : sub === "set" ? n : 0);
    return "<@" + id + "> now has " + u.xp + " XP (level " + progress(u.xp).level + "). Level roles only change at their next level-up.";
  }
  if (name === "noxp") {
    s.levels ||= {};
    const n = s.levels.noxp ||= { channels: [], roles: [] };
    const list = sub === "channel" ? n.channels : n.roles, id = opt(sub);
    const tag = sub === "channel" ? "<#" + id + ">" : "<@&" + id + ">";
    if (list.includes(id)) { list.splice(list.indexOf(id), 1); return tag + " earns XP again."; }
    list.push(id);
    return tag + " no longer earns XP.";
  }
  if (sub === "remove") {
    if (!s.bdays?.[self]) return "You don't have a birthday saved.";
    delete s.bdays[self];
    if (s.byear) delete s.byear[self];
    return "Removed.";
  }
  const day = parseDay(opt("date"));
  if (!day) return "I couldn't read that date. Try `10/22` or `Oct 22`.";
  (s.bdays ||= {})[self] = day;
  s.byear ||= {};
  if (opt("year")) s.byear[self] = opt("year"); else delete s.byear[self];
  return "Saved: " + dayName(day) + (opt("year") ? ", with your age in the shout-out." : ".");
}

// Gateway: guilds, guild messages, reactions. Reconnects on any close.
let seq = null, beat = null, me = null;
async function connect() {
  const { url } = await api("/gateway/bot");
  const ws = new WebSocket(url + "/?v=10&encoding=json");
  ws.onmessage = async ev => {
    const p = JSON.parse(ev.data);
    if (p.s) seq = p.s;
    if (p.op === 10) {
      clearInterval(beat);
      beat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), p.d.heartbeat_interval);
      ws.send(JSON.stringify({ op: 2, d: { token: TOKEN, intents: 1 | 512 | 1024, properties: { os: "linux", browser: "drc-bot", device: "drc-bot" } } }));
    } else if (p.op === 7 || p.op === 9) ws.close();
    else if (p.t === "READY") {
      me = p.d.user.id;
      console.log("connected as " + p.d.user.username);
      await api("/applications/" + p.d.user.id + "/guilds/" + GUILD + "/commands", "PUT", COMMANDS).catch(e => console.warn("commands: " + e.message));
    } else if (p.t === "MESSAGE_CREATE" && p.d.guild_id === GUILD && !p.d.author?.bot) kick();
    else if ((p.t === "MESSAGE_REACTION_ADD" || p.t === "MESSAGE_REACTION_REMOVE") && p.d.guild_id === GUILD && p.d.user_id !== me) kick(2000);
    else if (p.t === "INTERACTION_CREATE" && p.d.type === 2) answer(p.d).catch(e => console.warn("command failed: " + e.message));
  };
  ws.onclose = ev => { clearInterval(beat); console.warn("gateway closed " + ev.code); setTimeout(connect, 5000); };
}

connect();
run();
