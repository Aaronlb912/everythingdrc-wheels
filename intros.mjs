// One-time: post and pin a short intro in channels that were empty.
// Skips a channel if the bot already pinned something there.
const TOKEN = process.env.DISCORD_TOKEN;
async function api(path, method = "GET", body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch("https://discord.com/api/v10" + path, {
      method,
      headers: { Authorization: "Bot " + TOKEN, ...(body && { "Content-Type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
    if (r.status === 429) { await new Promise(s => setTimeout(s, ((await r.json()).retry_after || 1) * 1000)); continue; }
    if (!r.ok) throw new Error(path + " -> " + r.status + " " + (await r.text()));
    return r.status === 204 ? null : r.json();
  }
}
const INTROS = {
  "1562557516506988655": ["📜 Server rules", "1. Be kind. No harassment, hate, or slurs.\n2. Keep it in the right channel.\n3. No spam or self-promo without asking a mod.\n4. No NSFW.\n5. No spoilers outside spoiler tags.\n6. Mods have the final say.\n\nBreak the rules and you may get a warning, a timeout, or a ban."],
  "1534692321201754122": ["📢 Announcements", "Server news and the weekly wheel winners land here. Only mods can post."],
  "1534692492409049200": ["🔴 Live alerts", "You get a ping here when Dennis goes live on Twitch. Food Review Wednesday starts between 2 and 4 PM ET."],
  "1534692576559366344": ["🎬 Clips and highlights", "The best moments from stream. Post your favorite clips here."],
  "1562566308288012460": ["🏆 Wheel winners", "Every Monday the bot posts last week's wheel picks and the most voted suggestions, plus an all-time tally."],
  "1533847577827610768": ["🎥 Fan clips", "Share clips you made. React to the ones you like. Every Sunday the clip with the most reactions gets Clip of the week."],
  "1534692742783828072": ["😂 Memes", "Post memes. Keep it friendly and SFW."],
  "1562528269629399040": ["🍔 Food reviews", "Talk about food you tried. After each Food Review Wednesday, rate the food 1 to 10 here. The average gets posted Friday."],
  "1562541029075451925": ["🎮 Now playing", "What are you playing right now? Post it here, with a screenshot if you have one."],
  "1562541044057374861": ["👥 Looking for group", "Need people to play with? Post the game, platform, and when you're on."],
  "1562577701322227762": ["⬆️ Level ups", "MEE6 posts here when someone levels up from chatting. Mute this channel if you don't want the pings. Check your level anytime with /rank."],
  "1562541000595996802": ["🕹️ Game collection", "Show off your shelf, your setup, or your latest pickup."],
  "1562541015301230685": ["💰 Deals and finds", "Spotted a good sale or a rare find? Post the link and the price."],
  "1562540985580519556": ["🥗 Meal prep", "Share your meal prep, recipes, and what you're eating this week."],
};
for (const [id, [title, description]] of Object.entries(INTROS)) {
  try {
    const me = await api("/users/@me");
    const pins = await api("/channels/" + id + "/pins").catch(() => []);
    if (pins.some(p => p.author.id === me.id)) { console.log("skip", title); continue; }
    const msg = await api("/channels/" + id + "/messages", "POST", { embeds: [{ color: 0xe2552e, title, description }] });
    await api("/channels/" + id + "/pins/" + msg.id, "PUT");
    console.log("posted", title);
  } catch (e) {
    console.log("::warning::" + title + ": " + e.message);
  }
}
