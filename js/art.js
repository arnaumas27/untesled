/**
 * art.js — neon line illustrations, one per sound.
 *
 * Every drawing is plain strokes on a 1100 × 360 canvas (ground at y = 330),
 * coloured with stroke attributes. artSvg() renders it three times, a wide
 * faint halo, a softer glow and a crisp core, which looks like neon tubes
 * without any (slow) blur filter. The halo and glow layers are <use> copies of
 * the core, so animating the core (wheels, the jet's fan, the horse's legs)
 * moves every layer.
 *
 * Hooks for the UI:
 *   data-body            the whole vehicle (shake, pitch, hover)
 *   data-spin            wheels: data-cx, data-cy (pivot), data-rm (radius in metres)
 *   data-fan             the jet's fan blades
 *   data-leg + data-seg  horse legs: rotate(°) on 'upper' (hip/shoulder) and 'lower' (knee/hock)
 *   data-tail            the horse's tail
 *   data-glow            opacity follows the engine (jet exhaust, sublight drive, lantern)
 *   data-flame           exhaust flame on pops
 *   .head-glow / .tail-glow  lit with the engine / when braking (CSS)
 */

const CYAN = '#4fd8ff';
const PINK = '#ff4fd8';
const RED = '#ff3b5c';
const AMBER = '#ffb547';
const ORANGE = '#ff8a3d';
const WHITE = '#e6f6ff';
const VIOLET = '#a98bff';
const DIM = '#5f7fa6';

const rad = (d) => (d * Math.PI) / 180;
const pt = (cx, cy, r, deg) => `${(cx + r * Math.cos(rad(deg))).toFixed(1)} ${(cy + r * Math.sin(rad(deg))).toFixed(1)}`;

/** Spokes from r0 to r1, `n` of them, starting at angle a0. */
function spokes(cx, cy, r0, r1, n, a0 = -90) {
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = a0 + (360 * i) / n;
    d += `M${pt(cx, cy, r0, a)} L${pt(cx, cy, r1, a)} `;
  }
  return `<path d="${d.trim()}"/>`;
}

/** A band between two radii from a0 to a1 degrees (brake calipers). */
function band(cx, cy, r0, r1, a0, a1) {
  return `<path d="M${pt(cx, cy, r1, a0)} A${r1} ${r1} 0 0 1 ${pt(cx, cy, r1, a1)} L${pt(cx, cy, r0, a1)} A${r0} ${r0} 0 0 0 ${pt(cx, cy, r0, a0)} Z"/>`;
}

/** An arc of radius r from a0 to a1 degrees (clockwise). */
function arc(cx, cy, r, a0, a1, attrs = '') {
  const large = a1 - a0 > 180 ? 1 : 0;
  return `<path ${attrs} d="M${pt(cx, cy, r, a0)} A${r} ${r} 0 ${large} 1 ${pt(cx, cy, r, a1)}"/>`;
}

const circle = (cx, cy, r, attrs = '') => `<circle cx="${cx}" cy="${cy}" r="${r}" ${attrs}/>`;

/** A spinning group around (cx, cy); `rm` is the real wheel radius in metres. */
const spin = (cx, cy, rm, inner) => `<g data-spin data-cx="${cx}" data-cy="${cy}" data-rm="${rm}">${inner}</g>`;

/** Five wide spokes, as outlines. */
function wideSpokes(cx, cy, r0, r1, n, half0, half1) {
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = -90 + (360 * i) / n;
    d += `M${pt(cx, cy, r0, a - half0)} L${pt(cx, cy, r1, a - half1)} L${pt(cx, cy, r1, a + half1)} L${pt(cx, cy, r0, a + half0)} Z `;
  }
  return `<path d="${d.trim()}"/>`;
}

// ---------------------------------------------------------------------------
// The drawings
// ---------------------------------------------------------------------------

function gt3Wheel(cx, cy, r) {
  const rim = r - 19;
  return `
    <g stroke="${CYAN}">${circle(cx, cy, r)}${circle(cx, cy, r - 6, `stroke="${DIM}"`)}</g>
    <g stroke="${DIM}">${circle(cx, cy, rim - 12)}</g>
    <g stroke="${AMBER}">${band(cx, cy, rim - 16, rim - 6, 196, 248)}</g>
    <g stroke="${WHITE}">${circle(cx, cy, rim)}${spin(cx, cy, r / 196, spokes(cx, cy, 11, rim - 2, 10) + circle(cx, cy, 11))}</g>
    <g stroke="${PINK}">${circle(cx, cy, 5)}</g>`;
}

const GT3 = {
  lines: `
    <g stroke="${CYAN}">
      <path d="M112 304 C104 298 97 289 95 276 C93 258 94 236 100 220 C104 208 114 200 128 196 C200 182 300 150 380 118 C430 96 480 84 545 81 C585 80 610 86 628 96 C660 120 690 150 712 172 C770 166 830 168 880 182 C930 194 970 210 992 230 C1004 240 1006 262 1000 285 C996 298 985 306 965 308 L869 304 A80 80 0 1 0 731 304 L389 304 A84 84 0 1 0 247 304 Z"/>
      <path d="M690 168 L622 104 C600 92 575 90 548 90 C500 90 455 98 418 118 C400 128 388 140 380 152 C470 154 600 160 690 168 Z"/>
      <path d="M512 92 L516 157"/>
      <path stroke="${DIM}" d="M708 180 C714 220 712 268 704 300 M480 166 C472 210 474 258 484 300"/>
      <path d="M880 198 C780 198 640 200 500 202 C420 202 360 188 300 170"/>
      <path d="M676 174 C670 162 684 154 704 158 C710 166 698 174 676 174 Z"/>
    </g>
    <g stroke="${WHITE}">
      <path d="M565 197 L604 196"/>
      <ellipse cx="955" cy="207" rx="25" ry="13" transform="rotate(-28 955 207)"/>
      <ellipse cx="955" cy="207" rx="14" ry="6.5" transform="rotate(-28 955 207)"/>
      <path d="M960 284 L998 280"/>
      <ellipse cx="108" cy="292" rx="7" ry="4"/>
    </g>
    <g stroke="${PINK}">
      <path d="M392 296 L728 296"/>
      <path d="M928 312 L1000 298"/>
      <path d="M112 304 L150 292 L196 296"/>
      <path d="M226 172 L292 152 M232 180 L298 160"/>
      <path d="M86 106 L204 112 C210 113 212 118 210 124 L204 150 L92 150 C88 150 86 146 86 140 Z"/>
      <path stroke="${WHITE}" d="M92 136 C122 128 172 124 206 128"/>
      <path d="M256 166 C262 138 252 112 228 104 C212 99 198 104 192 114 M220 178 C228 150 218 122 196 112 C182 106 168 110 162 118"/>
    </g>
    <g stroke="${RED}"><path d="M96 224 L130 210"/></g>
    ${gt3Wheel(318, 259, 71)}
    ${gt3Wheel(800, 263, 67)}`,
  flame: [100, 292],
  head: [950, 206],
  tail: [112, 218],
};

function magnum(cx, cy) {
  return `
    <g stroke="${CYAN}">${circle(cx, cy, 66)}</g>
    <g stroke="${WHITE}">${arc(cx, cy, 58, 205, 335, 'stroke-dasharray="7 5"')}${circle(cx, cy, 42)}${spin(cx, cy, 0.34, wideSpokes(cx, cy, 11, 36, 5, 18, 8) + circle(cx, cy, 30) + circle(cx, cy, 8))}</g>`;
}

const MUSTANG = {
  lines: `
    <g stroke="${ORANGE}">
      <path d="M100 294 C94 290 92 286 92 280 C86 250 85 200 88 168 L82 158 L98 152 C200 136 380 100 500 86 C540 82 590 82 615 86 C650 104 690 134 712 150 C850 152 930 155 985 160 L1012 166 L1016 200 C1017 218 1014 230 1010 236 L1012 262 C1010 278 1000 290 985 294 L907 294 A78 78 0 1 0 763 294 L380 294 A80 80 0 1 0 232 294 Z"/>
      <path stroke="${DIM}" d="M716 160 C720 220 716 270 710 292 M470 152 C464 210 468 260 476 292"/>
      <path d="M372 202 L432 188 L434 206 L376 216 Z"/>
      <path d="M792 151 L798 136 C800 131 805 128 812 128 L848 128 C854 128 858 132 858 138 L858 152 M858 134 L872 134 L872 152"/>
    </g>
    <g stroke="${CYAN}">
      <path d="M704 150 L628 96 C590 90 545 90 505 96 C480 101 462 110 452 120 L462 148 Z"/>
      <path d="M560 92 L562 148"/>
    </g>
    <g stroke="${PINK}"><path d="M1000 184 C820 182 620 184 430 186 C300 187 180 186 92 186"/></g>
    <g stroke="${WHITE}">
      <path d="M972 238 L1004 238 C1016 238 1024 244 1024 251 C1024 258 1016 264 1004 264 L972 264"/>
      <path d="M118 242 L96 242 C84 242 78 247 78 253 C78 259 84 264 96 264 L118 264"/>
      ${circle(1003, 198, 9)}
      <path d="M484 172 L506 172"/>
      <path d="M690 150 C688 140 700 136 712 140 C712 146 704 150 690 150 Z"/>
      <rect x="98" y="281" width="30" height="9" rx="4.5"/>
    </g>
    <g stroke="${RED}"><path d="M86 194 L88 226"/></g>
    ${magnum(306, 264)}
    ${magnum(835, 264)}`,
  flame: [96, 286],
  head: [1010, 198],
  tail: [88, 210],
};

function bikeWheel(cx, cy, disc) {
  let pairs = '';
  for (let i = 0; i < 5; i++) {
    const a = -90 + i * 72;
    pairs += `M${pt(cx, cy, 10, a)} L${pt(cx, cy, 52, a - 7)} M${pt(cx, cy, 10, a)} L${pt(cx, cy, 52, a + 7)} `;
  }
  return `
    <g stroke="${CYAN}">${circle(cx, cy, 70)}${circle(cx, cy, 63, `stroke="${DIM}"`)}</g>
    <g stroke="${WHITE}">${circle(cx, cy, 54)}${spin(cx, cy, 0.3, `<path d="${pairs.trim()}"/>` + circle(cx, cy, disc, 'stroke-dasharray="4 5"') + circle(cx, cy, 9))}</g>`;
}

const MOTO = {
  lines: `
    ${bikeWheel(385, 260, 26)}
    ${bikeWheel(715, 260, 40)}
    <g stroke="${AMBER}">${band(715, 260, 34, 46, 205, 238)}</g>
    <g stroke="${WHITE}">
      <path d="M708 262 L648 106 M720 258 L660 102"/>
      <path d="M650 104 L626 112"/>
      <path d="M676 92 L690 84"/><ellipse cx="698" cy="81" rx="10" ry="5"/>
      <path d="M724 134 L742 146"/>
      <path d="M398 196 L470 214 L465 234 L392 218 Z"/>
      <path d="M604 268 C560 270 522 266 494 252 C480 244 472 234 468 226"/>
      <path d="M478 214 L494 220"/>
      <path stroke="${DIM}" d="M536 246 L502 238 L498 208 L522 194 M604 120 L516 196 L490 222"/>
    </g>
    <g stroke="${PINK}">
      <path d="M652 70 C676 76 704 96 724 118 L748 142 C750 148 746 154 738 155 L716 158 C708 172 702 188 698 204 L672 252 C664 264 652 270 636 272 L560 272 L536 246 L548 200 C560 168 584 138 612 116 C622 108 632 103 640 100 Z"/>
      <path d="M612 116 C600 98 570 90 538 92 C520 94 510 100 504 108"/>
      <path d="M504 108 C494 114 480 118 460 116 L440 112 C410 104 360 92 300 80 L304 92 C340 104 380 120 420 132 L470 140 L488 198"/>
      ${arc(715, 260, 78, 222, 300)}
    </g>
    <g stroke="${CYAN}">
      <path d="M648 82 C672 88 700 104 718 120"/>
      <path d="M736 152 C700 168 660 196 622 236"/>
      <path d="M646 206 L622 236 M658 212 L634 242"/>
      <path d="M385 252 L488 224 M385 268 L490 240"/>
    </g>
    <g stroke="${RED}"><path d="M300 82 L316 90"/></g>`,
  flame: [392, 208],
  head: [742, 146],
  tail: [306, 86],
  fit: 'translate(520 330) scale(1.15) translate(-520 -330)', // a bike is small next to a car
};

function fanBlades() {
  let d = '';
  for (let i = 0; i < 12; i++) {
    const a = i * 30;
    d += `M${pt(0, 0, 5, a)} L${pt(0, 0, 21, a + 14)} `;
  }
  return `<path d="${d.trim()}"/>`;
}

const JET = {
  lines: `
    <g stroke="${CYAN}">
      <path d="M1062 242 C1060 262 1040 280 1000 286 L300 284 C220 282 130 262 40 232 L44 224 C110 204 170 196 236 196 L960 196 C1010 196 1052 214 1062 242 Z"/>
      <path d="M300 196 C270 192 250 180 236 166 L122 30 L70 32 L76 200"/>
      <path stroke="${DIM}" d="M100 38 L104 196"/>
      <path d="M175 240 L76 222 L58 224 L150 250 Z"/>
      <path d="M612 278 L382 250 L354 252 L472 288 Z"/>
      <path d="M384 250 L362 196 L350 196 L356 252"/>
    </g>
    <g stroke="${WHITE}">
      <path d="M1000 213 L1030 214 L1044 222 L1006 223 Z M1020 213 L1024 223"/>
      <path stroke-dasharray="5 9" d="M920 226 L320 226"/>
      <rect x="936" y="210" width="16" height="50" rx="4"/>
      <rect x="306" y="210" width="14" height="48" rx="4"/>
      <rect x="566" y="218" width="10" height="24" rx="3"/>
      <ellipse cx="724" cy="295" rx="7" ry="23"/>
      <path d="M960 286 L960 314 M505 286 L505 312"/>
      ${spin(960, 318, 0.35, circle(960, 318, 12) + spokes(960, 318, 3, 9, 4))}
      ${spin(505, 316, 0.55, circle(505, 316, 14) + spokes(505, 316, 3, 11, 5))}
      <g transform="translate(724 295) scale(0.3 1)"><g data-fan>${circle(0, 0, 4)}${fanBlades()}</g></g>
    </g>
    <g stroke="${PINK}">
      <path d="M1058 252 C900 254 600 254 300 252 C220 250 130 240 60 230"/>
      <path d="M722 272 C730 282 730 306 722 318 L612 316 C598 312 588 306 578 298 L578 290 C590 280 600 274 614 272 Z"/>
      <path d="M578 289 L550 294 L578 299"/>
      <path d="M664 272 L648 262 L596 266 L606 272"/>
    </g>
    <g stroke="${RED}" class="beacon">${circle(620, 192, 3)}${circle(600, 289, 3)}</g>`,
  back: `<ellipse data-glow cx="512" cy="294" rx="52" ry="11" fill="url(#{P}-amber)"/>`,
};

/** A point on the freighter's hull ellipse (centre 480,190; 320 × 92). */
const hull = (deg, dy = 0, k = 1) => `${(480 + 320 * k * Math.cos(rad(deg))).toFixed(1)} ${(190 + dy + 92 * k * Math.sin(rad(deg))).toFixed(1)}`;

function hullPanels() {
  let d = '';
  for (const deg of [120, 150, 175, 205, 232, 300, 325]) d += `M${hull(deg, 0, 0.47)} L${hull(deg, 0, 0.97)} `;
  return `<path stroke="${DIM}" d="${d.trim()}"/>`;
}

const FREIGHTER = {
  lines: `
    <g stroke="${WHITE}">
      <path d="M760 234.5 A320 92 0 1 1 760 145.5 L948 166 C958 167 962 172 962 178 L962 182 L776 184 L776 196 L962 198 L962 204 C962 212 956 218 946 220 Z"/>
      <path d="M795 216 A320 92 0 0 1 165 216 M160 190 L160 210 M962 204 L962 220 C962 228 956 234 946 236 L788 252"/>
      <ellipse cx="470" cy="186" rx="150" ry="42"/>
      <ellipse cx="470" cy="186" rx="58" ry="17"/>
      ${circle(470, 186, 9)}
      <path d="M478 184 L522 177 M478 190 L524 185"/>
      <path d="M460 98 L460 86 L500 86 L500 98"/>
      <path d="M640 156 L648 140"/>
      <ellipse cx="650" cy="136" rx="26" ry="11" transform="rotate(-18 650 136)"/>
      ${hullPanels()}
    </g>
    <g stroke="${CYAN}">
      <path d="M622 266 L664 284 M650 260 L694 285"/>
      <path d="M668 282 L800 290 C814 291 822 297 822 303 C822 309 814 313 800 313 L668 306 C658 305 654 300 656 294 C658 288 662 283 668 282 Z"/>
      <path stroke-dasharray="6 6" d="M${hull(146, 0, 0.94)} A300.8 86.5 0 0 1 ${hull(214, 0, 0.94)}"/>
    </g>
    <g stroke="${AMBER}"><path d="M822 303 L806 292 M822 303 L806 313 M808 291 L808 314"/></g>`,
  back: `
    <ellipse data-glow cx="130" cy="190" rx="110" ry="70" fill="url(#{P}-cyan)"/>
    <path data-glow d="M${hull(142)} A320 92 0 0 1 ${hull(218)}" fill="none" stroke="#bff3ff" stroke-width="12" stroke-linecap="round"/>
    <ellipse data-glow cx="480" cy="318" rx="300" ry="8" fill="url(#{P}-cyan)" opacity="0.5"/>`,
  head: [812, 304],
  hover: true,
};

/** A horse leg: upper segment from the pivot, lower segment from the knee/hock. */
function leg(index, px, py, fore, faded) {
  const upper = fore
    ? 'M9 0 C11 20 9 40 7 56 M-11 0 C-11 22 -8 42 -7 56 M7 56 C4 60 -4 60 -7 56'
    : 'M13 0 C19 26 11 46 3 62 M-15 0 C-19 30 -15 50 -10 62 M3 62 C0 66 -8 66 -10 62';
  const knee = fore ? [0, 58] : [-3, 63];
  const lower = fore
    ? 'M6 0 L5 34 M-6 0 L-5 34 M5 34 C7 40 10 44 12 48 M-5 34 C-6 42 -2 46 2 48 M0 47 L14 47 L16 57 L-2 57 Z'
    : 'M5 0 L5 32 M-7 0 L-4 32 M5 32 C7 38 10 42 12 46 M-4 32 C-5 40 -1 44 3 46 M1 45 L15 45 L17 55 L-1 55 Z';
  return `<g transform="translate(${px} ${py})" ${faded ? `stroke="${DIM}"` : ''}>
      <g data-leg="${index}" data-seg="upper"><path d="${upper}"/>
        <g transform="translate(${knee[0]} ${knee[1]})"><g data-leg="${index}" data-seg="lower"><path d="${lower}"/></g></g>
      </g>
    </g>`;
}

function woodWheel(cx, cy, r, n, rm) {
  return `<g stroke="${CYAN}">${circle(cx, cy, r)}${circle(cx, cy, r - 8)}${spin(cx, cy, rm, spokes(cx, cy, r * 0.16, r - 8, n) + circle(cx, cy, r * 0.16))}</g>`;
}

const CARRIAGE = {
  lines: `
    <g stroke="${AMBER}">
      ${leg(2, 720, 210, false, true)}
      ${leg(0, 930, 214, true, true)}
      <path d="M965 228 C982 212 990 190 992 168 C994 150 996 136 1000 124 C1015 134 1034 144 1050 146 C1062 146 1067 134 1062 124 C1048 104 1028 84 1012 72 L1008 50 L999 66 C975 84 940 112 905 144 C870 156 830 160 780 158 C740 156 712 152 690 158 C676 164 668 180 668 200 C668 212 672 220 680 226 C760 236 860 236 965 228 Z"/>
      ${circle(1020, 94, 3)}
      <path d="M1056 132 C1052 128 1054 124 1058 126 M1046 142 L1056 140"/>
      <path stroke="${ORANGE}" d="M1000 70 C978 88 950 112 918 140 M994 80 C975 98 952 120 928 142 M1006 72 C1012 80 1018 84 1022 84"/>
      <g data-tail><path stroke="${ORANGE}" d="M672 172 C650 182 640 214 646 262 M674 178 C660 204 656 236 664 268 M670 168 C654 176 646 190 644 206"/></g>
      ${leg(3, 700, 212, false, false)}
      ${leg(1, 950, 215, true, false)}
    </g>
    <g stroke="${PINK}">
      <path d="M1004 120 L1056 128 M1018 86 L1004 120"/>
      <path d="M948 132 C970 138 986 166 980 202 M934 142 C952 156 960 182 954 210"/>
      <path d="M850 156 L884 152 L888 186 L852 190 Z M868 190 L866 232"/>
      <path d="M1030 125 C900 140 700 130 560 160"/>
    </g>
    <g stroke="${AMBER}"><path d="M500 248 C650 236 800 214 952 200 M502 256 C650 246 800 224 950 210"/></g>
    <g stroke="${VIOLET}">
      <path d="M160 232 C152 200 150 140 158 112 L162 100 C250 96 340 96 420 100 C428 101 432 106 432 114 L434 158 C456 164 470 186 468 212 C466 226 456 234 440 234 Z"/>
      <path d="M300 108 L416 108 L418 228 L302 228 Z"/>
      <rect x="316" y="116" width="86" height="52" rx="6"/>
      <path d="M180 116 L282 116 L282 166 L178 166 Z"/>
      <path d="M170 92 L414 92 M190 92 L190 99 M260 92 L260 98 M330 92 L330 98 M400 92 L400 99"/>
      <path stroke="${DIM}" d="M166 200 L298 200"/>
      <path d="M458 166 L540 160 L546 174 L462 180 Z M546 174 L578 214 L600 214 M470 180 L476 212"/>
      <path d="M205 245 C300 252 400 262 480 270 M236 236 C254 210 250 190 232 180"/>
      <ellipse cx="480" cy="240" rx="32" ry="6"/>
    </g>
    <g stroke="${AMBER}"><path d="M436 120 L452 120 L454 146 L434 146 Z M440 120 L444 112 L448 120"/></g>
    ${woodWheel(205, 245, 85, 12, 0.7)}
    ${woodWheel(480, 270, 60, 10, 0.5)}`,
  head: [444, 134],
  legs: true,
};

export const ART = { flat6: GT3, v8: MUSTANG, moto: MOTO, jet: JET, freighter: FREIGHTER, carriage: CARRIAGE };

const FLAME = `<path d="M0 -3 C-22 -17 -54 -17 -100 -5 C-54 7 -22 11 0 3 Z" fill="url(#{P}-flame)"/><path d="M0 -1 C-12 -7 -30 -7 -50 -2 C-30 3 -12 4 0 1 Z" fill="#fff6dc" opacity="0.85"/>`;

const DEFS = `
  <radialGradient id="{P}-cyan" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#d8f6ff" stop-opacity="0.95"/><stop offset="0.35" stop-color="${CYAN}" stop-opacity="0.55"/><stop offset="1" stop-color="${CYAN}" stop-opacity="0"/></radialGradient>
  <radialGradient id="{P}-amber" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff1d6" stop-opacity="0.95"/><stop offset="0.4" stop-color="${AMBER}" stop-opacity="0.5"/><stop offset="1" stop-color="${ORANGE}" stop-opacity="0"/></radialGradient>
  <linearGradient id="{P}-plume" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#d8f6ff" stop-opacity="0.9"/><stop offset="0.3" stop-color="${CYAN}" stop-opacity="0.45"/><stop offset="1" stop-color="${CYAN}" stop-opacity="0"/></linearGradient>
  <radialGradient id="{P}-head" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#e8f6ff" stop-opacity="0.95"/><stop offset="0.35" stop-color="#7fd3ff" stop-opacity="0.35"/><stop offset="1" stop-color="#7fd3ff" stop-opacity="0"/></radialGradient>
  <radialGradient id="{P}-tail" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ff5a6a" stop-opacity="0.9"/><stop offset="1" stop-color="${RED}" stop-opacity="0"/></radialGradient>
  <radialGradient id="{P}-shadow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#000" stop-opacity="0.75"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
  <linearGradient id="{P}-flame" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#e9f7ff"/><stop offset="0.18" stop-color="#7cc8ff"/><stop offset="0.4" stop-color="#ffb020"/><stop offset="0.75" stop-color="#ff4a1c" stop-opacity="0.75"/><stop offset="1" stop-color="#ff4a1c" stop-opacity="0"/></linearGradient>`;

/**
 * SVG markup for a sound's artwork.
 * @param {string} id sound id
 * @param {{prefix?: string, thumb?: boolean}} [opts] prefix keeps ids unique
 *   when several drawings share a page; thumb draws a small static version.
 */
export function artSvg(id, { prefix = 'art', thumb = false } = {}) {
  const a = ART[id] || ART.flat6;
  const P = prefix;
  const lines = `${P}-lines`;
  const fill = (s) => (s || '').split('{P}').join(P);
  let lights = '';
  if (!thumb && a.head) lights += `<ellipse class="head-glow" cx="${a.head[0]}" cy="${a.head[1]}" rx="70" ry="30" fill="url(#${P}-head)"/>`;
  if (!thumb && a.tail) lights += `<ellipse class="tail-glow" cx="${a.tail[0]}" cy="${a.tail[1]}" rx="48" ry="24" fill="url(#${P}-tail)"/>`;
  const flame = !thumb && a.flame ? `<g transform="translate(${a.flame[0]} ${a.flame[1]})"><g data-flame class="flame">${fill(FLAME)}</g></g>` : '';
  const glow = thumb ? '' : `<g class="neon-halo"><use href="#${lines}"/></g><g class="neon-mid"><use href="#${lines}"/></g>`;
  return `<svg viewBox="0 18 1100 330" class="art art-${id}${thumb ? ' art-thumb' : ''}" aria-hidden="true" focusable="false">
    <defs>${fill(DEFS)}</defs>
    <ellipse cx="550" cy="332" rx="520" ry="14" fill="url(#${P}-shadow)"/>
    <line class="floor" x1="0" y1="331" x2="1100" y2="331"/>
    <g data-body><g ${a.fit ? `transform="${a.fit}"` : ''}>
      ${thumb ? '' : fill(a.back)}
      ${flame}
      ${glow}
      <g class="neon-core"><g id="${lines}">${a.lines}</g></g>
      ${lights}
    </g></g>
  </svg>`;
}

/** Does this drawing hover (no wheels on the ground)? Does it have legs? */
export function artTraits(id) {
  const a = ART[id] || ART.flat6;
  return { hover: !!a.hover, hasLegs: !!a.legs };
}
