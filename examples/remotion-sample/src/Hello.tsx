import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';

// Minimal sample composition: a title that slides and a big frame counter, so a
// reviewer (and the e2e tests) can see which frame the preview is showing.
export const Hello: React.FC = () => {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [0, 150], [-300, 300]);
  return (
    <AbsoluteFill style={{background: 'linear-gradient(135deg,#1e3a8a,#7c3aed)', color: 'white', fontFamily: 'sans-serif', justifyContent: 'center', alignItems: 'center'}}>
      <div style={{fontSize: 96, transform: `translateX(${x}px)`}}>Review me</div>
      <div id="frame-counter" style={{fontSize: 48, marginTop: 40}}>frame {frame}</div>
    </AbsoluteFill>
  );
};
