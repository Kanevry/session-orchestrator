import React from 'react';
import {AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {z} from 'zod';
import {cameraAt, ProductionScene} from './ProductionScene';
import {theme} from './theme';
import {LogoMark} from './LogoMark';

export const campaignSchema = z.object({
  version: z.string().min(1).max(12),
  currentRelease: z.string().min(1).max(12),
  planned: z.boolean(),
});
export type CampaignProps = z.infer<typeof campaignSchema>;
export const campaignDefaults: CampaignProps = {version: '4.3', currentRelease: '4.2.0', planned: true};

const easing = Easing.inOut(Easing.cubic);
const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const show = (time: number, start: number, end: number) => interpolate(time, [start, start + 0.45, end - 0.35, end], [0, 1, 1, 0], clamp);

const Brand: React.FC = () => <div style={{display: 'flex', alignItems: 'center', gap: 18}}>
  <LogoMark />
  <span style={{fontSize: 30, fontWeight: 500, letterSpacing: -1.2}}>session orchestrator</span>
</div>;

const TextScene: React.FC<{time: number; start: number; end: number; label: string; title: string; copy: string}> = ({time, start, end, label, title, copy}) => {
  const opacity = show(time, start, end);
  const y = interpolate(time, [start, start + 0.65], [24, 0], {...clamp, easing});
  return <div style={{position: 'absolute', left: 100, top: 302, width: 640, opacity, transform: `translateY(${y}px)`}}>
    <div style={{fontFamily: theme.body, fontSize: 20, letterSpacing: 3.4, textTransform: 'uppercase', color: theme.lime, marginBottom: 32}}>{label}</div>
    <div style={{fontFamily: theme.display, fontSize: 80, letterSpacing: -4.5, lineHeight: 1.06, fontWeight: 500, whiteSpace: 'pre-line'}}>{title}</div>
    <div style={{fontFamily: theme.body, fontSize: 29, color: theme.muted, lineHeight: 1.52, maxWidth: 590, marginTop: 34}}>{copy}</div>
  </div>;
};

const StageTrack: React.FC<{time: number}> = ({time}) => {
  const progress = interpolate(time, [3.5, 18.8], [0, 1], clamp);
  const active = time < 9 ? 0 : time < 15 ? 1 : 2;
  const opacity = show(time, 3.4, 19.15);
  return <div style={{position: 'absolute', left: 101, top: 826, width: 578, opacity}}>
    <div style={{position: 'relative', height: 2, background: theme.line}}><div style={{width: `${progress * 100}%`, height: 2, background: theme.lime}} /></div>
    <div style={{display: 'flex', justifyContent: 'space-between', marginTop: 21}}>{['Plan', 'Go', 'Close'].map((label, i) => <div key={label} style={{fontSize: 22, fontWeight: 500, color: i === active ? theme.lime : theme.muted}}>{label}</div>)}</div>
  </div>;
};

export const ReleaseFilm: React.FC<CampaignProps> = (props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const time = frame / fps;
  const outro = interpolate(time, [18.65, 19.45], [0, 1], {...clamp, easing});
  const camera = cameraAt(time);
  const opening = interpolate(time, [0, 0.8], [0, 1], {...clamp, easing});
  const introOpacity = interpolate(time, [0, 0.5, 3.7, 4.15], [0, 1, 1, 0], clamp);

  return <AbsoluteFill style={{background: theme.bg, color: theme.white, fontFamily: theme.display}}>
    <ProductionScene camera={camera} style={{left: 655, top: 128, width: 1265, height: 844, opacity: opening}} />
    <div style={{position: 'absolute', left: 625, top: 128, height: 844, width: 150, background: 'linear-gradient(90deg, #101113, #10111300)'}} />
    <div style={{position: 'absolute', inset: '0 0 0 0', background: theme.bg, opacity: outro * 0.6}} />
    <div style={{position: 'absolute', left: 100, right: 100, top: 68, display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
      <Brand />
    </div>

    <div style={{position: 'absolute', left: 100, top: 289, width: 700, opacity: introOpacity}}>
      <div style={{fontFamily: theme.body, fontSize: 20, color: theme.lime, letterSpacing: 3.2, textTransform: 'uppercase', marginBottom: 32}}>A working rhythm for coding agents</div>
      <div style={{fontSize: 80, lineHeight: 1.06, fontWeight: 500, letterSpacing: -4.3}}>Give your agents<br />a working rhythm.</div>
      <p style={{fontFamily: theme.body, fontSize: 28, lineHeight: 1.55, color: theme.muted, maxWidth: 590, marginTop: 35}}>Plan the work. Check the result.<br />Pick up where you left off.</p>
    </div>

    <TextScene time={time} start={3.9} end={9.15} label="01 / Plan" title={'Read the project.\nAgree the work.'} copy="One shared plan. Clear responsibilities before implementation starts." />
    <TextScene time={time} start={9} end={15.15} label="02 / Go" title={'Work in parallel.\nCheck it together.'} copy="Give independent tasks room to move. Combine the changes and verify the result." />
    <TextScene time={time} start={15} end={19.1} label="03 / Close" title={'Keep the result.\nSee what’s next.'} copy="Record what passed and what remains. Give the next session a clear place to begin." />
    <StageTrack time={time} />

    <div style={{position: 'absolute', left: 100, top: 912, width: 670, fontFamily: theme.body, fontSize: 19, color: theme.muted, lineHeight: 1.4, opacity: show(time, 9.2, 15)}}>Parallel on Claude Code and Codex.<br />Cursor and Pi run tasks sequentially.</div>

    <div style={{position: 'absolute', left: 100, top: 307, opacity: outro}}>
      <div style={{fontSize: 112, fontWeight: 500, letterSpacing: -5.8, lineHeight: 1.08}}>Plan. Go. Close.</div>
      <div style={{fontFamily: theme.body, fontSize: 32, color: theme.muted, marginTop: 28}}>Your next session starts here.</div>
      <div style={{display: 'inline-block', background: theme.lime, color: theme.bg, fontFamily: theme.body, fontSize: 26, fontWeight: 600, padding: '18px 27px', borderRadius: 8, marginTop: 45}}>session-orchestrator.com <span style={{marginLeft: 23}}>↗</span></div>
      <div style={{fontFamily: theme.body, fontSize: 22, color: theme.muted, marginTop: 29}}>Free and open source · MIT</div>
    </div>

    <div style={{position: 'absolute', left: 100, right: 100, bottom: 50, borderTop: `1px solid ${theme.line}`, paddingTop: 22, fontFamily: theme.body, fontSize: 17, color: theme.muted, display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
      <span>Illustrative workflow · AI-generated artwork</span>
      <span>{props.planned ? `Planned campaign · Current release ${props.currentRelease}` : `Version ${props.version}`}</span>
    </div>
  </AbsoluteFill>;
};

export const ReleasePoster: React.FC<CampaignProps> = (props) => <AbsoluteFill style={{background: theme.bg, color: theme.white, fontFamily: theme.display}}>
  <ProductionScene camera={{scale: 1.015, x: 0, y: 0}} style={{left: 630, top: 128, width: 1290, height: 860}} />
  <div style={{position: 'absolute', left: 600, top: 128, height: 860, width: 160, background: 'linear-gradient(90deg, #101113, #10111300)'}} />
  <div style={{position: 'absolute', left: 100, top: 70}}><Brand /></div>
  <div style={{position: 'absolute', left: 100, top: 310, width: 630}}>
    <div style={{font: `20px ${theme.body}`, letterSpacing: 3.2, textTransform: 'uppercase', color: theme.lime, marginBottom: 27}}>A rhythm for your coding agents</div>
    <div style={{fontSize: 99, letterSpacing: -5, fontWeight: 500, lineHeight: 1.04}}>Plan.<br />Go.<br />Close.</div>
    <div style={{font: `25px ${theme.body}`, color: theme.muted, marginTop: 35}}>session-orchestrator.com</div>
  </div>
  <div style={{position: 'absolute', left: 100, right: 100, bottom: 51, borderTop: `1px solid ${theme.line}`, paddingTop: 23, font: `17px ${theme.body}`, color: theme.muted, display: 'flex', justifyContent: 'space-between'}}><span>Illustrative workflow · AI-generated artwork</span><span>{props.planned ? `Planned campaign · Current release ${props.currentRelease}` : `Version ${props.version}`}</span></div>
</AbsoluteFill>;
