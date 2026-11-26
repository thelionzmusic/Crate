// Find better version: Soulseek searched for a track you have, showing only copies better than
// yours, best first. The one you pick downloads (falling back to the next if it fails) and, once
// analysed, takes the old copy's place in every playlist, with its rating, colour and cues.
import { h, icon, mount } from "../core/dom.js";
import { api, safe, toast } from "../core/api.js";
import { sheet } from "../core/ui.js";
import { fmtTime } from "../core/format.js";

const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
const pick = ({ user, filename, size, quality, lossless }) => ({ user, filename, size, quality, lossless });

export const betterSheet = safe(async (t) => {
  const { sid, have } = await api("slsk/better", { id: t.id });
  const list = h("div", { class: "better" }, h("div", { class: "row t3" }, "Searching Soulseek…"));
  let found = [], alive = true;
  const choose = async (src, close) => {
    await api("slsk/download", { ...pick(src), replace: t.id, alts: found.filter((s) => s !== src).map(pick) });
    toast(`Downloading ${src.quality} from ${src.user}. Once it's analysed it replaces ${t.title} in your playlists`, 6000);
    close(true);
  };
  const draw = (done, close) => {
    const rows = found.map((s, i) => h("div", { class: "row" },
      h("div", { class: "grow" }, h("div", { class: "ttl" }, s.name),
        h("div", { class: "t3" }, `${s.user}${s.free ? ", free slot" : `, queue ${s.queue}`}`,
          s.longer ? h("span", { class: "warn" }, `, ${Math.abs(s.longer)} s ${s.longer > 0 ? "longer" : "shorter"}: maybe another edit`) : null)),
      h("span", { class: "tag" + (s.lossless ? " good" : "") }, s.quality),
      h("span", { class: "t3 num", style: "width:44px" }, s.length ? fmtTime(s.length) : ""),
      h("span", { class: "t3 num", style: "width:64px" }, mb(s.size)),
      h("button", { class: "btn sm" + (i ? "" : " primary"), onclick: safe(() => choose(s, close)) }, "Use this")));
    mount(list, ...(rows.length ? rows : [h("div", { class: "row t3" }, done ? `Nobody is sharing a better copy than your ${have} right now` : "Searching Soulseek…")]));
  };
  await sheet({
    title: `Find better version: ${t.title}`, width: 720,
    text: `You have ${have}${t.artist ? ` of ${t.artist} – ${t.title}` : ""}. These are better copies of the same track, best first.`,
    body: (close) => {
      (async () => {
        for (let i = 0; alive && i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          if (!alive) return;
          const r = await api("slsk/better", { id: t.id, sid }).catch(() => null);
          if (!r) continue;
          found = r.options; draw(r.done, close);
          if (r.done) return;
        }
        draw(true, close);
      })();
      return h("div", {}, list, h("p", { class: "t3", style: "margin:10px 2px 0" }, icon("i-check", "i sm"),
        " The old copy stays in your library; only your playlists change. Only download what you're allowed to."));
    },
    actions: [{ label: "Close", result: false }],
  });
  alive = false;
});
