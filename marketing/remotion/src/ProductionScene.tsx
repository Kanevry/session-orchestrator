import React from 'react';
import {AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {theme} from './theme';

export type Camera = {scale: number; x: number; y: number; origin?: string};

/** This is a camera move over one illustration, not animation of a working app. */
export const ProductionScene: React.FC<{camera: Camera; style?: React.CSSProperties}> = ({camera, style}) => (
  <div style={{position: 'absolute', overflow: 'hidden', ...style}}>
    <Img
      src={staticFile('production.webp')}
      style={{width: '100%', height: '100%', objectFit: 'cover', transformOrigin: camera.origin ?? '50% 50%', transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`}}
    />
  </div>
);

/** One closed sine/cosine orbit, with matching value and velocity at the seam. */
export const ProductionLoop: React.FC = () => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const phase = (frame / durationInFrames) * Math.PI * 2;
  const camera = {
    scale: 1.025 + 0.009 * (1 - Math.cos(phase)),
    x: Math.sin(phase) * 5,
    y: (Math.cos(phase) - 1) * 2,
  };
  return <AbsoluteFill style={{background: theme.bg}}><ProductionScene camera={camera} style={{inset: 0}} /></AbsoluteFill>;
};

export const cameraAt = (time: number): Camera => ({
  scale: interpolate(time, [0, 4, 7, 10, 13, 16, 19, 22], [1.015, 1.045, 1.085, 1.06, 1.09, 1.05, 1.025, 1.015]),
  x: interpolate(time, [0, 4, 7, 10, 13, 16, 19, 22], [0, 12, 25, 0, -18, -24, 0, 0]),
  y: interpolate(time, [0, 4, 7, 10, 13, 16, 19, 22], [0, 8, 12, 0, -5, -6, 0, 0]),
});
