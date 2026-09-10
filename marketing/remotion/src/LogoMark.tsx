import React from 'react';
import {Img, staticFile} from 'remotion';

/** One replaceable SVG asset supplied by the brand owner. */
export const LogoMark: React.FC = () => <Img src={staticFile('brand-mark.svg')} style={{width: 45, height: 45}} />;
