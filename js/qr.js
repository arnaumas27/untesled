/**
 * qr.js — zero-dependency QR Code (Model 2) generator.
 *
 * Byte mode only (UTF-8), all 40 versions, error-correction levels L/M/Q/H.
 * The smallest version that fits is chosen, then the ECC level is boosted
 * for free if the data still fits in that version (more robust scanning).
 * Output is a module matrix or a crisp SVG string.
 *
 * Based on the ISO/IEC 18004 algorithm; structure follows the well-known
 * reference implementation by Project Nayuki (MIT).
 */

// Error-correction codewords per block, indexed [level][version].
const ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

// Number of error-correction blocks, indexed [level][version].
const NUM_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

// 2-bit format code for each level (note: not in L,M,Q,H order).
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const LEVELS = ['L', 'M', 'Q', 'H'];

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Number of modules available for data + ECC in a version. */
function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver, ecl) {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
}

/** Centre coordinates of the alignment patterns for a version. */
function alignmentPositions(ver, size) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---- Reed–Solomon over GF(2^8), primitive polynomial 0x11D ----

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

/** Split data into blocks, append ECC to each, interleave. */
function addEccAndInterleave(data, ver, ecl) {
  const numBlocks = NUM_BLOCKS[ecl][ver];
  const blockEccLen = ECC_PER_BLOCK[ecl][ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const divisor = rsDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0); // placeholder, skipped when interleaving
    blocks.push(dat.concat(ecc));
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// ---- Matrix construction ----

class Matrix {
  constructor(size) {
    this.size = size;
    this.modules = new Uint8Array(size * size); // 1 = dark
    this.isFunction = new Uint8Array(size * size);
  }
  /** Set a function (non-data) module. x = column, y = row. */
  fn(x, y, dark) {
    const i = y * this.size + x;
    this.modules[i] = dark ? 1 : 0;
    this.isFunction[i] = 1;
  }
}

function drawFinder(m, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= m.size || y >= m.size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      m.fn(x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawFormatBits(m, ecl, mask) {
  const data = (FORMAT_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) !== 0;
  const size = m.size;

  // First copy, around the top-left finder.
  for (let i = 0; i <= 5; i++) m.fn(8, i, bit(i));
  m.fn(8, 7, bit(6));
  m.fn(8, 8, bit(7));
  m.fn(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.fn(14 - i, 8, bit(i));

  // Second copy, split between the other two finders.
  for (let i = 0; i < 8; i++) m.fn(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.fn(8, size - 15 + i, bit(i));
  m.fn(8, size - 8, true); // the "dark module"
}

function drawVersionBits(m, ver) {
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (ver << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m.fn(a, b, dark);
    m.fn(b, a, dark);
  }
}

function drawFunctionPatterns(m, ver, ecl) {
  const size = m.size;
  for (let i = 0; i < size; i++) {
    m.fn(6, i, i % 2 === 0);
    m.fn(i, 6, i % 2 === 0);
  }
  drawFinder(m, 3, 3);
  drawFinder(m, size - 4, 3);
  drawFinder(m, 3, size - 4);

  const pos = alignmentPositions(ver, size);
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // Skip the three corners occupied by finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          m.fn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  drawFormatBits(m, ecl, 0); // reserves the area; real bits drawn after masking
  drawVersionBits(m, ver);
}

/** Place codeword bits in the zig-zag pattern, skipping function modules. */
function drawCodewords(m, codewords) {
  const size = m.size;
  let i = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        const idx = y * size + x;
        if (!m.isFunction[idx] && i < totalBits) {
          m.modules[idx] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }
}

function applyMask(m, mask) {
  const f = MASKS[mask];
  const size = m.size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      if (!m.isFunction[idx] && f(x, y)) m.modules[idx] ^= 1;
    }
  }
}

/** Number of light modules starting at `start` going `step` (outside counts as light), max 4. */
function lightRun(line, start, step) {
  let n = 0;
  for (let i = start; n < 4; i += step) {
    if (i >= 0 && i < line.length && line[i]) break;
    n++;
  }
  return n;
}

/** ISO penalty score used to pick the best mask (lower is better). */
function penaltyScore(m) {
  const { size, modules } = m;
  let score = 0;
  const line = new Uint8Array(size);

  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let runColor = -1;
      let runLen = 0;
      for (let b = 0; b < size; b++) {
        const v = pass === 0 ? modules[a * size + b] : modules[b * size + a];
        line[b] = v;
        if (v === runColor) {
          runLen++;
          if (runLen === 5) score += 3;
          else if (runLen > 5) score += 1;
        } else {
          runColor = v;
          runLen = 1;
        }
      }
      // Finder-like 1:1:3:1:1 pattern with 4 light modules on one side.
      for (let b = 0; b + 6 < size; b++) {
        if (line[b] && !line[b + 1] && line[b + 2] && line[b + 3] && line[b + 4] && !line[b + 5] && line[b + 6]) {
          if (lightRun(line, b - 1, -1) >= 4 || lightRun(line, b + 7, 1) >= 4) score += 40;
        }
      }
    }
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y * size + x];
      if (c === modules[y * size + x + 1] && c === modules[(y + 1) * size + x] && c === modules[(y + 1) * size + x + 1]) {
        score += 3;
      }
    }
  }

  let dark = 0;
  for (let i = 0; i < modules.length; i++) dark += modules[i];
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;
  return score;
}

/**
 * Encode text into a QR matrix.
 * @param {string} text
 * @param {'L'|'M'|'Q'|'H'} [minEcl='M'] minimum error-correction level
 * @returns {{size:number, modules:Uint8Array, version:number, ecl:string, mask:number}}
 */
export function qrEncode(text, minEcl = 'M') {
  const bytes = Array.from(new TextEncoder().encode(String(text)));

  // Smallest version that fits at the minimum ECC level.
  let ver = 1;
  const bitsNeeded = (v) => 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
  for (; ver <= 40; ver++) {
    if (bitsNeeded(ver) <= dataCodewords(ver, minEcl) * 8) break;
  }
  if (ver > 40) throw new RangeError('QR: data too long');

  // Boost the ECC level while the data still fits in this version.
  let ecl = minEcl;
  for (const lvl of LEVELS.slice(LEVELS.indexOf(minEcl) + 1)) {
    if (bitsNeeded(ver) <= dataCodewords(ver, lvl) * 8) ecl = lvl;
  }

  // Build the bit stream: mode, count, data, terminator, padding.
  const capacityBits = dataCodewords(ver, ecl) * 8;
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);

  const data = new Array(bits.length / 8).fill(0);
  bits.forEach((b, i) => {
    data[i >>> 3] |= b << (7 - (i & 7));
  });

  const codewords = addEccAndInterleave(data, ver, ecl);
  const size = ver * 4 + 17;

  // Try all 8 masks and keep the one with the lowest penalty.
  let best = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    const m = new Matrix(size);
    drawFunctionPatterns(m, ver, ecl);
    drawCodewords(m, codewords);
    applyMask(m, mask);
    drawFormatBits(m, ecl, mask);
    const score = penaltyScore(m);
    if (score < bestScore) {
      bestScore = score;
      best = m;
      bestMask = mask;
    }
  }

  return { size, modules: best.modules, version: ver, ecl, mask: bestMask };
}

/**
 * Render text as an SVG QR code string.
 * Dark modules are merged into horizontal runs to keep the path small.
 */
export function qrSvg(text, { ecl = 'M', border = 4, dark = '#000', light = '#fff', label = 'QR code' } = {}) {
  const { size, modules } = qrEncode(text, ecl);
  const dim = size + border * 2;
  let d = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (modules[y * size + x]) {
        let end = x;
        while (end < size && modules[y * size + end]) end++;
        d += `M${x + border} ${y + border}h${end - x}v1h${x - end}z`;
        x = end;
      } else {
        x++;
      }
    }
  }
  const safeLabel = String(label).replace(/[<>&"]/g, '');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${safeLabel}">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${d}" fill="${dark}"/></svg>`
  );
}
