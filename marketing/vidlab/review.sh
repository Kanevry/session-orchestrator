#!/bin/zsh
cd /tmp/vidlab
{
cat <<'HEAD'
<!doctype html><meta charset=utf-8><title>Workshop-Video Review</title>
<style>
body{background:#14110f;color:#F5F1EA;font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:28px}
h1{font-size:22px;margin:0 0 6px} p.sub{color:#9a9088;margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:22px}
figure{margin:0;background:#1d1916;border:1px solid #2e2823;border-radius:10px;overflow:hidden}
video{width:100%;display:block;background:#000}
figcaption{padding:10px 12px;font-size:13px}
.t{font-weight:600} .m{color:#9a9088}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;margin-right:6px}
.free{background:#1d3b28;color:#8fd6a6} .paid{background:#3b2a12;color:#e6b877}
img.still{width:100%;display:block}
</style>
<h1>Werkstatt-Animation — Runde 1</h1>
<p class="sub">Alle Clips 8 s. Gratis = lokales Gateway (Grok Imagine 1.5), bezahlt = OpenRouter. Ton ist bewusst egal, der Site-Loop läuft stumm.</p>
<div class="grid">
HEAD
for f in *.mp4; do
  b=${f%.mp4}
  case $b in
    g-*|x-*) tag='<span class="tag free">gratis · grok-imagine-video-1.5</span>';;
    or-veo|*veo*) tag='<span class="tag paid">bezahlt · veo-3.1-fast</span>';;
    or-kling|*kling*) tag='<span class="tag paid">bezahlt · kling-3.0-pro</span>';;
    *hailuo*) tag='<span class="tag paid">bezahlt · hailuo-3-max</span>';;
    *) tag='';;
  esac
  cost=$(jq -r '.usage.cost // empty' "$b-result.json" 2>/dev/null)
  dim=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$f" 2>/dev/null)
  echo "<figure><video src=\"$f\" controls loop muted playsinline></video><figcaption><span class=\"t\">$b</span><br>$tag<span class=\"m\">$dim${cost:+ · $cost USD}</span></figcaption></figure>"
done
echo '</div><h1 style="margin-top:36px">Neue Startbilder (gratis, gpt-image-2)</h1><div class="grid">'
for i in m1-stations.png m2-closeup.png m3-night.png; do [ -s "$i" ] && echo "<figure><img class=still src=\"$i\"><figcaption><span class=t>${i%.png}</span></figcaption></figure>"; done
echo '</div>'
} > review.html
echo /tmp/vidlab/review.html
{
echo '<h1 style="margin-top:36px">Fertige Artefakte aus dem besten Clip</h1><div class="grid">'
for v in loop-closeup loop-workshop; do
  [ -f "$v.mp4" ] && echo "<figure><video src=\"$v.mp4\" autoplay loop muted playsinline controls></video><figcaption><span class=t>$v</span><br><span class=m>nahtloser Loop, 960px, stumm · mp4 $(du -h $v.mp4|cut -f1) · webm $(du -h $v.webm|cut -f1) · gif $(du -h $v.gif|cut -f1)</span></figcaption></figure>"
done
[ -f loop-closeup.webp ] && echo "<figure><img class=still src=\"loop-closeup.webp\"><figcaption><span class=t>loop-closeup.webp</span><br><span class=m>animiertes WebP für GitHub README · $(du -h loop-closeup.webp|cut -f1) (GIF wäre $(du -h loop-closeup-tiny.gif|cut -f1))</span></figcaption></figure>"
echo '</div>'
} >> review.html
