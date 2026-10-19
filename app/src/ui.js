// Shared UI bits for the v0.3 design (mockup/index.html): palette, icons, small helpers.
import { memo } from 'react';
import Svg, { Path, Rect, Circle } from 'react-native-svg';
export const C = { bg: '#05070a', panel: '#0d1217', panel2: '#0f151b', tile: '#151c23', tile2: '#1b232b', acc: 'rgba(200,255,77,0.13)', txt: '#e8eef2', dim: '#7d8a96', faint: '#4a5560',
  ff: '#c8ff4d', amber: '#ffb84a', red: '#ff5a5a', blue: '#5ad1ff', violet: '#d59bff' };
export const MONO = 'monospace';
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export function lockColor(err) { // red -> amber -> green
  if (!isFinite(err)) return [125, 138, 150];
  const q = clamp(1 - (err - 12) / 220, 0, 1), st = [[255, 90, 90], [255, 184, 74], [200, 255, 77]];
  const k = q * 2, i = Math.min(1, Math.floor(k)), f = k - i, a = st[i], b = st[i + 1]; return a.map((v, j) => Math.round(v + (b[j] - v) * f));
}
export const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
export const lockFrac = (err) => isFinite(err) ? clamp(1 - (err - 12) / 260, 0, 1) : 0;
export function arcPath(cx, cy, r, a0, a1) { // angles in radians, 0 = 3 o'clock
  const large = a1 - a0 > Math.PI ? 1 : 0, x0 = cx + Math.cos(a0) * r, y0 = cy + Math.sin(a0) * r, x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
  return `M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}
const ICONS = {
  restart: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4.2h-4.2'], download: ['M12 4v11', 'M7.5 10.5 12 15l4.5-4.5', 'M5 19.5h14'], arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  ble: ['M7 7.5l10 9-5 4.5V3l5 4.5-10 9'], audio: ['M4 9.5h3.5L12 6v12l-4.5-3.5H4z', 'M15.5 9.5a3.5 3.5 0 0 1 0 5', 'M18 7a7 7 0 0 1 0 10'],
  torch: ['M8 3h8v3.5l-2 3.5v11h-4V10L8 6.5z', 'M8 6.5h8', 'M12 13.5v2'], peers: ['M3.5 19a5.5 5.5 0 0 1 11 0', 'M16 5.8a3 3 0 0 1 0 5.4', 'M17.5 14.5a5.5 5.5 0 0 1 3 4.5'],
  timer: ['M12 10v3.5l2.3 2.3', 'M9.5 3h5'], lock: ['M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3'], sync: ['M19.5 10.5A7.5 7.5 0 0 0 6 7.2', 'M5.5 3.5v4h4', 'M4.5 13.5A7.5 7.5 0 0 0 18 16.8', 'M18.5 20.5v-4h-4'],
  screen: ['M10.5 18.5h3'],
};
export const Icon = memo(function Icon({ name, size = 16, color = C.dim, sw = 1.8 }) {
  const p = { fill: 'none', stroke: color, strokeWidth: sw, strokeLinecap: 'round', strokeLinejoin: 'round' };
  return <Svg width={size} height={size} viewBox="0 0 24 24">
    {(ICONS[name] || []).map((d, i) => <Path key={i} d={d} {...p} />)}
    {name === 'peers' && <Circle cx={9} cy={8.5} r={3} {...p} />}
    {name === 'timer' && <Circle cx={12} cy={13.5} r={7.5} {...p} />}
    {name === 'lock' && <Rect x={5} y={10.5} width={14} height={10} rx={2.5} {...p} />}
    {name === 'screen' && <Rect x={6.5} y={2.5} width={11} height={19} rx={2.5} {...p} />}
  </Svg>;
});
