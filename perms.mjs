// One-time: list who can see each channel. With APPLY=1, open the listed IDs to @everyone.
const TOKEN = process.env.DISCORD_TOKEN, G = "1533847576619520082";
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
}
const VIEW = 1n << 10n;
const roles = Object.fromEntries((await api("/guilds/" + G + "/roles")).map(r => [r.id, r.name]));
const chans = await api("/guilds/" + G + "/channels");
const name = Object.fromEntries(chans.map(c => [c.id, c.name]));
for (const c of chans.sort((a, b) => (a.parent_id || a.id).localeCompare(b.parent_id || b.id) || a.position - b.position)) {
  const ow = (c.permission_overwrites || []).map(o => {
    const who = o.id === G ? "@everyone" : roles[o.id] || o.id;
    const v = BigInt(o.allow) & VIEW ? "+view" : BigInt(o.deny) & VIEW ? "-view" : "";
    return v && who + v;
  }).filter(Boolean).join(" ");
  console.log([c.id, c.type, name[c.parent_id] || "-", c.name, ow, c.permission_overwrites?.length && c.parent_id ? "" : ""].join(" | "));
}
for (const id of (process.env.OPEN || "").split(",").filter(Boolean)) {
  const c = chans.find(x => x.id === id);
  const o = c.permission_overwrites.find(o => o.id === G) || { allow: "0", deny: "0" };
  await api("/channels/" + id + "/permissions/" + G, "PUT", {
    type: 0, allow: String(BigInt(o.allow) | VIEW), deny: String(BigInt(o.deny) & ~VIEW),
  });
  console.log("opened", c.name);
}
const all = await api("/guilds/" + G + "/roles");
for (const r of all) console.log("ROLE", r.name, BigInt(r.permissions) & VIEW ? "view" : "NO-view");
const ob = await api("/guilds/" + G + "/onboarding").catch(e => ({ err: e.message }));
console.log("ONBOARD enabled=" + ob.enabled, "mode=" + ob.mode, "defaults=" + (ob.default_channel_ids || []).map(id => name[id]).join(","));
for (const p of ob.prompts || []) for (const o of p.options) console.log("OPTION", p.title, "/", o.title, "roles=" + o.role_ids.map(id => roles[id]).join(","), "chans=" + o.channel_ids.map(id => name[id]).join(","));
const MENTION = 1n << 17n, live = chans.find(c => c.name === "live-alerts");
for (const r of all) if (BigInt(r.permissions) & (MENTION | 8n)) console.log("MENTION role", r.name, BigInt(r.permissions) & 8n ? "admin" : "");
for (const o of live?.permission_overwrites || []) console.log("MENTION live", roles[o.id] || o.id, BigInt(o.allow) & MENTION ? "+mention" : "", BigInt(o.deny) & MENTION ? "-mention" : "");
console.log("MENTION me", (await api("/users/@me")).username, (await api("/guilds/" + G + "/members/" + (await api("/users/@me")).id)).roles.map(id => roles[id]).join(","));
// Let the bot's live alert ping @everyone, in #live-alerts only.
const ws = all.find(r => r.name === "Wheel Sync"), wo = live.permission_overwrites.find(o => o.id === ws.id) || { allow: "0", deny: "0" };
if (!(BigInt(wo.allow) & MENTION)) { await api("/channels/" + live.id + "/permissions/" + ws.id, "PUT", { type: 0, allow: String(BigInt(wo.allow) | MENTION), deny: String(BigInt(wo.deny) & ~MENTION) }); console.log("MENTION granted"); }
