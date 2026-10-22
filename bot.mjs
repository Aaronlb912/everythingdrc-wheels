// Always-on DRC Bot. Runs on the Oracle server under systemd (drc-bot.service).
// Keeps a gateway connection so messages, joins and reactions trigger sync.mjs
// within seconds instead of every 2 minutes, and answers slash commands.
// sync.mjs still does all the work; this file only decides when to run it.
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

const TOKEN = process.env.DISCORD_TOKEN;
const KEY = Buffer.from(process.env.STATE_KEY || "", "base64");
const GUILD = "1533847576619520082";
if (!TOKEN || KEY.length !== 32) { console.error("DISCORD_TOKEN or STATE_KEY missing"); process.exit(1); }

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

function state() {
  const b = Buffer.from(fs.readFileSync("state.enc", "utf8"), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
}

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
const COMMANDS = [
  { name: "rank", description: "Show your level and XP", options: [{ type: 6, name: "member", description: "Someone else's rank" }] },
  { name: "leaderboard", description: "Top 10 by XP" },
];
async function answer(i) {
  const s = state(), users = s.levels?.users || {};
  const ranked = Object.entries(users).sort((a, b) => b[1].xp - a[1].xp);
  let content;
  if (i.data.name === "rank") {
    const id = i.data.options?.[0]?.value || i.member.user.id;
    const u = users[id], at = ranked.findIndex(([k]) => k === id);
    if (!u) content = "<@" + id + "> has no XP yet. Chat to earn some.";
    else {
      const p = progress(u.xp);
      content = "<@" + id + "> · rank #" + (at + 1) + " · level " + p.level + " · " + p.into + "/" + p.next + " XP to level " + (p.level + 1) + " · " + u.xp + " XP total";
    }
  } else {
    content = ranked.length
      ? "**Leaderboard**\n" + ranked.slice(0, 10).map(([id, u], n) => (n + 1) + ". <@" + id + "> · level " + progress(u.xp).level + " · " + u.xp + " XP").join("\n")
      : "No XP yet. Say something!";
  }
  await api("/interactions/" + i.id + "/" + i.token + "/callback", "POST", { type: 4, data: { content, allowed_mentions: { parse: [] } } });
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
