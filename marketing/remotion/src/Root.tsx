import React from 'react';
import {Composition, Still} from 'remotion';
import {campaignDefaults, campaignSchema, ReleaseFilm, ReleasePoster} from './ReleaseFilm';
import {ProductionLoop} from './ProductionScene';

export const RemotionRoot: React.FC = () => <>
  <Composition id="ReleaseFilm" component={ReleaseFilm} width={1920} height={1080} fps={30} durationInFrames={660} defaultProps={campaignDefaults} schema={campaignSchema} />
  <Composition id="ProductionLoop" component={ProductionLoop} width={960} height={640} fps={30} durationInFrames={270} />
  <Still id="ReleasePoster" component={ReleasePoster} width={1920} height={1080} defaultProps={campaignDefaults} schema={campaignSchema} />
</>;
