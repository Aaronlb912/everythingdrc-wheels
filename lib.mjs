// Shared by sync.mjs and bot.mjs: picture cards and the birthday date parser.
import { Resvg } from "@resvg/resvg-js";

export const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function parseDay(text) {
  let mo, d;
  const num = text.match(/\b(\d{1,2})[\/.-](\d{1,2})\b/);
  const word = text.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
  if (num) [mo, d] = [+num[1], +num[2]];
  else if (word) [mo, d] = [MONTHS.indexOf(word[1]) + 1, +word[2]];
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(2024, mo, 0).getDate()) return null;
  return String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}
export const dayName = d => MONTHS[+d.slice(0, 2) - 1][0].toUpperCase() + MONTHS[+d.slice(0, 2) - 1].slice(1) + " " + +d.slice(3);

const ACCENT = "#e2552e", BG = "#1e1f22", TRACK = "#3f4147", MUTED = "#b5bac1";
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export const displayName = u => u.global_name || u.username;

async function avatar(u) {
  const url = u.avatar
    ? "https://cdn.discordapp.com/avatars/" + u.id + "/" + u.avatar + ".png?size=256"
    : "https://cdn.discordapp.com/embed/avatars/" + Number((BigInt(u.id) >> 22n) % 6n) + ".png";
  try {
    const r = await fetch(url);
    if (r.ok) return "data:image/png;base64," + Buffer.from(await r.arrayBuffer()).toString("base64");
  } catch {}
  return null;
}
function circle(img, cx, cy, r) {
  return img
    ? `<clipPath id="a"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath><image href="${img}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" clip-path="url(#a)"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${TRACK}"/>`;
}
const png = svg => new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" } }).render().asPng();

export async function rankCard({ user, rank, level, into, next, xp }) {
  const w = Math.max(36, Math.round(620 * into / next));
  return png(`<svg xmlns="http://www.w3.org/2000/svg" width="934" height="282" font-family="DejaVu Sans">
  <rect width="934" height="282" rx="24" fill="${BG}"/>
  ${circle(await avatar(user), 141, 141, 96)}
  <circle cx="141" cy="141" r="96" fill="none" stroke="${ACCENT}" stroke-width="6"/>
  <text x="890" y="78" text-anchor="end" fill="${MUTED}" font-size="26">RANK <tspan fill="#fff" font-size="44" font-weight="bold">#${rank}</tspan>   LEVEL <tspan fill="${ACCENT}" font-size="44" font-weight="bold">${level}</tspan></text>
  <text x="270" y="170" fill="#fff" font-size="38" font-weight="bold">${esc(short(displayName(user), 18))}</text>
  <text x="890" y="170" text-anchor="end" fill="${MUTED}" font-size="24">${into} / ${next} XP</text>
  <rect x="270" y="192" width="620" height="36" rx="18" fill="${TRACK}"/>
  <rect x="270" y="192" width="${w}" height="36" rx="18" fill="${ACCENT}"/>
  <text x="270" y="262" fill="${MUTED}" font-size="20">${xp} XP total</text>
</svg>`);
}

export async function welcomeCard({ user, count }) {
  return png(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="460" font-family="DejaVu Sans">
  <rect width="1024" height="460" rx="24" fill="${BG}"/>
  <rect width="1024" height="12" fill="${ACCENT}"/>
  ${circle(await avatar(user), 512, 160, 100)}
  <circle cx="512" cy="160" r="100" fill="none" stroke="${ACCENT}" stroke-width="8"/>
  <text x="512" y="320" text-anchor="middle" fill="#fff" font-size="54" font-weight="bold">WELCOME</text>
  <text x="512" y="376" text-anchor="middle" fill="${ACCENT}" font-size="38">${esc(short(displayName(user), 24))}</text>
  <text x="512" y="424" text-anchor="middle" fill="${MUTED}" font-size="26">${count ? "Member #" + count + " · " : ""}EverythingDRC</text>
</svg>`);
}

// Discord message body with one PNG attached.
export function form(payload, name, buf) {
  const fd = new FormData();
  fd.append("payload_json", JSON.stringify({ ...payload, attachments: [{ id: 0, filename: name }] }));
  fd.append("files[0]", new Blob([buf], { type: "image/png" }), name);
  return fd;
}
