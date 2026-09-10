import {loadFont} from '@remotion/fonts';
import {staticFile} from 'remotion';

loadFont({family: 'Space Grotesk', url: staticFile('space-grotesk.woff2'), weight: '400 700'});
loadFont({family: 'Inter', url: staticFile('inter.woff2'), weight: '400 700'});

export const theme = {
  bg: '#101113',
  white: '#F5F3EE',
  muted: '#BBC0C5',
  lime: '#D5F478',
  line: '#34383C',
  display: 'Space Grotesk',
  body: 'Inter',
};
