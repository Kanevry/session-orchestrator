# vidlab: image-to-video toolchain

The campaign film in `site/video/session-orchestrator-film.mp4` was not rendered with
Remotion. Remotion moves a camera over one still image (`marketing/remotion/src/ProductionScene.tsx`
says so in its own comment); vidlab generates the motion itself, through an image-to-video model.

Everything here is shell plus ffmpeg plus one Python file. No new runtime dependency enters
the plugin or the website.

## The two doors

| Door | Endpoint | Cost | Use |
|---|---|---|---|
| Local gateway | `http://127.0.0.1:8319/v1/videos`, key from the local gateway config | none | drafts |
| OpenRouter | `https://openrouter.ai/api/v1/videos`, key from the operator's private env, see the vault note | per clip | production |

Measured 2026-09-11, same start image and prompt for each model:

| Model | Resolution | Cost per 8 s |
|---|---|---|
| `google/veo-3.1-fast` with `resolution: "1080p"` | 1920x1080 | 0.9504 USD |
| `kwaivgi/kling-v3.0-pro` | 1760x1176 | 1.3306 USD |
| `minimax/hailuo-3-max` | 1152x768 | 0.6336 USD |
| `grok-imagine-video-1.5-preview` (gateway) | 1168x784 | none |

Veo returns 1080p for the same price as 720p, but only when `resolution` is sent. Omitting it
is the single most expensive mistake in this pipeline.

## Commands

```sh
./img.sh  <name> <prompt>                                  # start image, gpt-image-2, free
./lab.sh  <name> <gateway|or> <model> <prompt-file> [image] [seconds] [aspect]
./ladder.sh <out.mp4> <clip:speed:label.png:seconds> ...   # hard cuts, speed per beat
./smooth.sh <out.mp4> <xfade-sec> <clip:speed:label:sec> ...
./audiobed.sh <video> <audio-source> <out>                 # one bed, loudnorm -14 LUFS
./loopify.sh <in.mp4> <outbase> [width] [xfade]            # seamless loop, mp4 + webm + gif + poster
python3 mklabel.py "<text>" <out.png>                      # text overlay, this ffmpeg has no drawtext
```

## Four rules that carry the result

1. **Chain the frames.** The last frame of a clip becomes the start image of the next one
   (`ffmpeg -sseof -0.1 -i clip.mp4 -frames:v 1 next-start.png`). The camera then moves out of
   the picture the viewer is already watching. That is continuity, not a dissolve over a cut.
2. **Crop the start image to the target aspect before submitting.** Otherwise the model frames
   it itself: black bars, or a rebuilt composition. Derive the height from the actual width;
   `gpt-image-2` does not always return the size it was asked for.
3. **One action per clip.** Two simultaneous actions are the usual cause of morphing. Name the
   empty places too ("no other person ever appears, the upstairs office stays empty"), or figures
   appear mid-clip.
4. **Judge motion in motion.** Contact strips (`select='not(mod(n\,20))',tile=4x2`) show whether
   the structure holds. They cannot show whether the movement is smooth. A person has to watch
   the clip before a model is chosen.

## Host quirks

This ffmpeg has no `drawtext` and no webp encoder: labels come from `mklabel.py`, webp from
`cwebp` and `img2webp`. Animated webp beats gif by a wide margin at the same quality
(1.7 MB against 5.1 MB for one clip), and needs `-lossy`.

Full capability note, including the dramaturgy and the cost model: the operator's vault.
