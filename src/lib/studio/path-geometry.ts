/**
 * ICON SHEET STUDIO — Pure vector geometry MEASUREMENT for fill-based
 * icon artwork.
 *
 * NO DOM, NO rasterization, NO OUTPUT GEOMETRY — plain math only.
 *
 * ROLE (measurement-only): real-world "outline" icons are often drawn as
 * FILLED closed paths. To thicken such artwork NON-DESTRUCTIVELY, the
 * styling engine adds a paint-order stroke whose width is derived from
 * the element's native outline thickness, measured here:
 *
 *   1. geometry:  <path> d-attribute | <polygon>/<rect>/<circle>/<ellipse>
 *                 → flattened closed polygons (Bézier/arc curves sampled
 *                 adaptively to a tolerance in icon units — SAMPLING IS
 *                 INTERNAL TO THE MEASUREMENT ONLY; it is NEVER emitted)
 *   2. classify:  subpaths are nested into a containment tree (each hole
 *                 is a direct child of its outer contour) — pure geometry,
 *                 no boolean library involved
 *   3. measure:   native outline thickness  T̂ = 2·A / P   — EXACT for
 *                 bars (line of length L, width W: 2·L·W/2L = W) and for
 *                 annulus rings (2·π(R²−r²)/2π(R+r) = R−r), a robust
 *                 estimate for everything else
 *
 * THIS MODULE NEVER GENERATES, OFFSETS, RESAMPLES OR REBUILDS OUTPUT
 * PATH DATA. The old destructive erosion pipeline (ClipperOffset +
 * polygon→path rebuild) was removed — and with it the entire clipper-lib
 * dependency: stroke-weight adjustment must never destroy SVG geometry
 * (vector integrity > visual shortcut).
 *
 * Every step is deterministic and side-effect free. Elements whose
 * geometry cannot be measured (open/degenerate shapes) are reported as
 * null so the caller leaves them untouched instead of guessing.
 *
 * Coordinates are float (icon user units).
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One closed polygon (fill semantics always close implicitly). */
export interface Poly {
  pts: [number, number][];
}

/** Maximum recursion depth for adaptive Bézier flattening. */
const MAX_CURVE_DEPTH = 18;

/** One subpath tracked during a FULL-`d` parse: its moveto's character
 *  index, its ABSOLUTE start point (a relative 'm' start resolves
 *  through the previous subpath's endpoint — the whole-`d` parse is the
 *  ONLY correct way to position such spans), and its sampled polygon
 *  (null when degenerate). */
export interface TrackedSubpath {
  startIndex: number;
  start: [number, number];
  pts: [number, number][] | null;
}

/* ------------------------------------------------------------------ */
/* d-attribute tokenizer (cursor-based, SVG grammar compliant)         */
/* ------------------------------------------------------------------ */

interface Cursor {
  s: string;
  i: number;
}

const WS_RE = /[\s,]/;
const DIGIT_RE = /[0-9]/;
const CMD_RE = /[MmLlHhVvCcSsQqTtAaZz]/;

function skipSep(c: Cursor): void {
  while (c.i < c.s.length && WS_RE.test(c.s[c.i])) c.i++;
}

/** Number per SVG grammar: sign? digits? ("." digits?)? exponent? — also
 *  accepts ".5" and tolerates sign-separated lists ("1-2" → 1 then -2). */
function readNumber(c: Cursor): number | null {
  skipSep(c);
  const start = c.i;
  if (c.s[c.i] === "+" || c.s[c.i] === "-") c.i++;
  let sawDigit = false;
  while (c.i < c.s.length && DIGIT_RE.test(c.s[c.i])) {
    c.i++;
    sawDigit = true;
  }
  if (c.s[c.i] === ".") {
    c.i++;
    while (c.i < c.s.length && DIGIT_RE.test(c.s[c.i])) {
      c.i++;
      sawDigit = true;
    }
  }
  if (!sawDigit) {
    c.i = start;
    return null;
  }
  if (c.s[c.i] === "e" || c.s[c.i] === "E") {
    const save = c.i;
    c.i++;
    if (c.s[c.i] === "+" || c.s[c.i] === "-") c.i++;
    if (c.i < c.s.length && DIGIT_RE.test(c.s[c.i])) {
      while (c.i < c.s.length && DIGIT_RE.test(c.s[c.i])) c.i++;
    } else {
      c.i = save; // not an exponent — leave for the next token
    }
  }
  const n = parseFloat(c.s.slice(start, c.i));
  return Number.isFinite(n) ? n : null;
}

/** Arc flags are single 0/1 characters and may be packed without separators. */
function readFlag(c: Cursor): 0 | 1 | null {
  skipSep(c);
  const ch = c.s[c.i];
  if (ch === "0" || ch === "1") {
    c.i++;
    return ch === "1" ? 1 : 0;
  }
  return null;
}

function readCommand(c: Cursor): string | null {
  skipSep(c);
  const ch = c.s[c.i];
  if (ch && CMD_RE.test(ch)) {
    c.i++;
    return ch;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Curve flattening                                                    */
/* ------------------------------------------------------------------ */

function ptSegDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

function flattenCubic(
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  tol: number, out: [number, number][], depth = 0
): void {
  if (depth >= MAX_CURVE_DEPTH) {
    out.push([x3, y3]);
    return;
  }
  const d = ptSegDist(x1, y1, x0, y0, x3, y3) + ptSegDist(x2, y2, x0, y0, x3, y3);
  if (d <= tol) {
    out.push([x3, y3]);
    return;
  }
  const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
  const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
  const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
  const xa = (x01 + x12) / 2, ya = (y01 + y12) / 2;
  const xb = (x12 + x23) / 2, yb = (y12 + y23) / 2;
  const xm = (xa + xb) / 2, ym = (ya + yb) / 2;
  flattenCubic(x0, y0, x01, y01, xa, ya, xm, ym, tol, out, depth + 1);
  flattenCubic(xm, ym, xb, yb, x23, y23, x3, y3, tol, out, depth + 1);
}

function flattenQuadratic(
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
  tol: number, out: [number, number][], depth = 0
): void {
  if (depth >= MAX_CURVE_DEPTH) {
    out.push([x2, y2]);
    return;
  }
  const d = ptSegDist(x1, y1, x0, y0, x2, y2);
  if (d * 2 <= tol) {
    out.push([x2, y2]);
    return;
  }
  const xa = (x0 + x1) / 2, ya = (y0 + y1) / 2;
  const xb = (x1 + x2) / 2, yb = (y1 + y2) / 2;
  const xm = (xa + xb) / 2, ym = (ya + yb) / 2;
  flattenQuadratic(x0, y0, xa, ya, xm, ym, tol, out, depth + 1);
  flattenQuadratic(xm, ym, xb, yb, x2, y2, tol, out, depth + 1);
}

/** SVG elliptical-arc → sampled polyline (endpoint-to-center conversion,
 *  SVG spec F.6.5). Appends all segment points EXCEPT the start point. */
function flattenArc(
  rx: number, ry: number, rotDeg: number, largeArc: number, sweep: number,
  x1: number, y1: number, x2: number, y2: number,
  tol: number, out: [number, number][]
): void {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
    out.push([x2, y2]);
    return;
  }
  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = den > 0 ? Math.sqrt(Math.max(0, num / den)) : 0;
  if (largeArc === sweep) co = -co;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const t1 = Math.atan2(uy, ux);
  /* P7: Δθ per SVG spec F.6.5 — the signed angle FROM u TO v:
   *  atan2(cross(u, v), dot(u, v)). The previous operand order
   *  (vx·uy − vy·ux) computed the NEGATIVE angle, so every arc with
   *  |Δθ| ≠ 180° traced the LONG way around (verified against the
   *  browser renderer's own getBBox for all four largeArc×sweep
   *  combinations; exact half-arcs were unaffected — ±180° is
   *  symmetric — which is why full circles built from half-arcs always
   *  measured correctly). */
  let dTheta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const rMax = Math.max(rx, ry);
  const stepMax = 2 * Math.acos(Math.min(1, Math.max(-1, 1 - tol / rMax)));
  const n = Math.min(256, Math.max(4, Math.ceil(Math.abs(dTheta) / Math.max(stepMax, 0.02))));
  for (let k = 1; k <= n; k++) {
    const theta = t1 + (dTheta * k) / n;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    out.push([
      cx + rx * ct * cosP - ry * st * sinP,
      cy + rx * ct * sinP + ry * st * cosP,
    ]);
  }
}

/* ------------------------------------------------------------------ */
/* d-attribute interpreter                                             */
/* ------------------------------------------------------------------ */

/**
 * Parse an SVG path `d` attribute into flattened closed polygons.
 * Handles absolute/relative commands, implicit repetition (incl. the
 * M→L rule), H/V, S/T control-point reflection, arcs (incl. packed flags
 * and radii scaling), and Z. Open subpaths are implicitly closed — fill
 * semantics close them anyway.
 */
export function parsePathD(
  d: string,
  tol: number,
  spansOut?: TrackedSubpath[],
  /** P7 (icon-fit): OPTIONAL collector for OPEN 2-point line subpaths —
   *  the polygon output intentionally drops them (fill-measurement
   *  semantics), but an open line still paints STROKE ink and its points
   *  matter for bounds. Purely additive: polys/spansOut are unchanged. */
  openPtsOut?: [number, number][]
): Poly[] | null {
  if (!d) return null;
  const polys: Poly[] = [];
  let cur: [number, number][] | null = null;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let cmd: string | null = null;
  let prevCmd = "";
  let prevCubic: [number, number] | null = null;
  let prevQuad: [number, number] | null = null;
  const c: Cursor = { s: d, i: 0 };

  const push = (x: number, y: number): void => {
    if (!cur) cur = [[x, y]];
    else cur.push([x, y]);
    cx = x;
    cy = y;
  };
  /* subpath tracker — the span being accumulated (its moveto index +
   *  resolved absolute start point); flush() closes it out, moveto
   *  opens the next one. */
  let spanStart: { index: number; x: number; y: number } | null = null;
  const flush = (): void => {
    if (cur) {
      if (cur.length >= 3) polys.push({ pts: cur });
      else if (cur.length === 2 && openPtsOut) openPtsOut.push(cur[0], cur[1]);
      if (spansOut && spanStart) {
        spansOut.push({
          startIndex: spanStart.index,
          start: [spanStart.x, spanStart.y],
          pts: cur.length >= 3 ? cur : null,
        });
      }
    }
    cur = null;
  };

  for (;;) {
    skipSep(c);
    if (c.i >= c.s.length) break;
    const cmdStart = c.i; /* index of the command character (moveto tracking) */
    const ch = readCommand(c);
    if (ch) {
      cmd = ch;
      if (ch === "Z" || ch === "z") {
        flush();
        cx = sx;
        cy = sy;
        prevCubic = null;
        prevQuad = null;
        prevCmd = "Z";
        continue;
      }
    } else {
      if (cmd === null) break; // trailing junk — stop
      // implicit repetition: M→L, everything else repeats; after Z be lenient
      if (cmd === "M") cmd = "L";
      else if (cmd === "m") cmd = "l";
      else if (cmd === "Z") cmd = "L";
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    switch (C) {
      case "M": {
        const x = readNumber(c);
        const y = readNumber(c);
        if (x == null || y == null) { cmd = null; break; }
        const nx = rel ? cx + x : x;
        const ny = rel ? cy + y : y;
        flush();
        cur = [[nx, ny]];
        sx = nx;
        sy = ny;
        cx = nx;
        cy = ny;
        spanStart = { index: cmdStart, x: nx, y: ny };
        prevCubic = null;
        prevQuad = null;
        prevCmd = "M";
        break;
      }
      case "L": {
        const x = readNumber(c);
        const y = readNumber(c);
        if (x == null || y == null) { cmd = null; break; }
        push(rel ? cx + x : x, rel ? cy + y : y);
        prevCubic = null;
        prevQuad = null;
        prevCmd = "L";
        break;
      }
      case "H": {
        const x = readNumber(c);
        if (x == null) { cmd = null; break; }
        push(rel ? cx + x : x, cy);
        prevCubic = null;
        prevQuad = null;
        prevCmd = "H";
        break;
      }
      case "V": {
        const y = readNumber(c);
        if (y == null) { cmd = null; break; }
        push(cx, rel ? cy + y : y);
        prevCubic = null;
        prevQuad = null;
        prevCmd = "V";
        break;
      }
      case "C": {
        const nums: number[] = [];
        for (let k = 0; k < 6; k++) {
          const n = readNumber(c);
          if (n == null) { nums.length = 0; break; }
          nums.push(n);
        }
        if (nums.length < 6) { cmd = null; break; }
        const p1: [number, number] = [rel ? cx + nums[0] : nums[0], rel ? cy + nums[1] : nums[1]];
        const p2: [number, number] = [rel ? cx + nums[2] : nums[2], rel ? cy + nums[3] : nums[3]];
        const p3: [number, number] = [rel ? cx + nums[4] : nums[4], rel ? cy + nums[5] : nums[5]];
        flattenCubic(cx, cy, p1[0], p1[1], p2[0], p2[1], p3[0], p3[1], tol, cur ?? (cur = []));
        prevCubic = p2;
        prevQuad = null;
        cx = p3[0];
        cy = p3[1];
        prevCmd = "C";
        break;
      }
      case "S": {
        const nums: number[] = [];
        for (let k = 0; k < 4; k++) {
          const n = readNumber(c);
          if (n == null) { nums.length = 0; break; }
          nums.push(n);
        }
        if (nums.length < 4) { cmd = null; break; }
        const reflect: [number, number] =
          prevCmd === "C" || prevCmd === "S"
            ? prevCubic
              ? [2 * cx - prevCubic[0], 2 * cy - prevCubic[1]]
              : [cx, cy]
            : [cx, cy];
        const p1 = reflect;
        const p2: [number, number] = [rel ? cx + nums[0] : nums[0], rel ? cy + nums[1] : nums[1]];
        const p3: [number, number] = [rel ? cx + nums[2] : nums[2], rel ? cy + nums[3] : nums[3]];
        flattenCubic(cx, cy, p1[0], p1[1], p2[0], p2[1], p3[0], p3[1], tol, cur ?? (cur = []));
        prevCubic = p2;
        prevQuad = null;
        cx = p3[0];
        cy = p3[1];
        prevCmd = "S";
        break;
      }
      case "Q": {
        const nums: number[] = [];
        for (let k = 0; k < 4; k++) {
          const n = readNumber(c);
          if (n == null) { nums.length = 0; break; }
          nums.push(n);
        }
        if (nums.length < 4) { cmd = null; break; }
        const p1: [number, number] = [rel ? cx + nums[0] : nums[0], rel ? cy + nums[1] : nums[1]];
        const p2: [number, number] = [rel ? cx + nums[2] : nums[2], rel ? cy + nums[3] : nums[3]];
        flattenQuadratic(cx, cy, p1[0], p1[1], p2[0], p2[1], tol, cur ?? (cur = []));
        prevQuad = p1;
        prevCubic = null;
        cx = p2[0];
        cy = p2[1];
        prevCmd = "Q";
        break;
      }
      case "T": {
        const x = readNumber(c);
        const y = readNumber(c);
        if (x == null || y == null) { cmd = null; break; }
        const p1: [number, number] =
          prevCmd === "Q" || prevCmd === "T"
            ? prevQuad
              ? [2 * cx - prevQuad[0], 2 * cy - prevQuad[1]]
              : [cx, cy]
            : [cx, cy];
        const nx = rel ? cx + x : x;
        const ny = rel ? cy + y : y;
        flattenQuadratic(cx, cy, p1[0], p1[1], nx, ny, tol, cur ?? (cur = []));
        prevQuad = p1;
        prevCubic = null;
        cx = nx;
        cy = ny;
        prevCmd = "T";
        break;
      }
      case "A": {
        const rx = readNumber(c);
        const ry = readNumber(c);
        const rot = readNumber(c);
        const laf = readFlag(c);
        const sf = readFlag(c);
        const x = readNumber(c);
        const y = readNumber(c);
        if (
          rx == null || ry == null || rot == null || laf == null ||
          sf == null || x == null || y == null
        ) { cmd = null; break; }
        flattenArc(
          rx, ry, rot, laf, sf,
          cx, cy, rel ? cx + x : x, rel ? cy + y : y,
          tol, cur ?? (cur = [])
        );
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        prevCubic = null;
        prevQuad = null;
        prevCmd = "A";
        break;
      }
      default:
        cmd = null;
        break;
    }
    if (cmd === null) break;
  }
  flush();
  return polys.length > 0 ? polys : null;
}

/* ------------------------------------------------------------------ */
/* Shape elements → polygons                                           */
/* ------------------------------------------------------------------ */

function num(el: Element, name: string, fallback: number): number {
  const v = parseFloat(el.getAttribute(name) ?? "");
  return Number.isFinite(v) ? v : fallback;
}

/** Full ellipse (or circle) sampled to arc-tolerance precision. */
function ellipsePoly(cx: number, cy: number, rx: number, ry: number, tol: number): Poly | null {
  if (!(rx > 0) || !(ry > 0)) return null;
  const rMax = Math.max(rx, ry);
  const stepMax = 2 * Math.acos(Math.min(1, Math.max(-1, 1 - tol / rMax)));
  const n = Math.min(128, Math.max(8, Math.ceil((2 * Math.PI) / Math.max(stepMax, 0.02))));
  const pts: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const t = (k / n) * 2 * Math.PI;
    pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return { pts };
}

/** Rect (incl. rounded corners) → polygon. */
function rectPoly(el: Element, tol: number): Poly | null {
  const x = num(el, "x", 0);
  const y = num(el, "y", 0);
  const w = num(el, "width", 0);
  const h = num(el, "height", 0);
  if (!(w > 0) || !(h > 0)) return null;
  let rx = Math.abs(num(el, "rx", 0));
  let ry = Math.abs(num(el, "ry", 0));
  rx = Math.min(rx, w / 2);
  ry = Math.min(ry, h / 2);
  if (rx <= 0) ry = 0;
  if (ry <= 0) rx = 0;
  if (rx <= 0 || ry <= 0) {
    return { pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] };
  }
  // rounded corners: quarter-ellipse samples
  const rMax = Math.max(rx, ry);
  const stepMax = 2 * Math.acos(Math.min(1, Math.max(-1, 1 - tol / rMax)));
  const nq = Math.min(16, Math.max(2, Math.ceil((Math.PI / 2) / Math.max(stepMax, 0.02))));
  const pts: [number, number][] = [];
  const corner = (
    ox: number, oy: number, a0: number
  ): void => {
    for (let k = 1; k <= nq; k++) {
      const t = a0 + ((Math.PI / 2) * k) / nq;
      pts.push([ox + rx * Math.cos(t), oy + ry * Math.sin(t)]);
    }
  };
  // start at (x+rx, y), walk clockwise
  corner(x + w - rx, y + ry, -Math.PI / 2); // top-right corner
  corner(x + w - rx, y + h - ry, 0); // bottom-right
  corner(x + rx, y + h - ry, Math.PI / 2); // bottom-left
  corner(x + rx, y + ry, Math.PI); // top-left
  return { pts };
}

/** Geometry of a leaf shape element (path/polygon/rect/circle/ellipse)
 *  in its LOCAL coordinate system. `line`/`polyline` are open → null. */
export function elementPolys(el: Element, tol: number): Poly[] | null {
  const tag = el.localName?.toLowerCase() ?? "";
  if (tag === "path") {
    return parsePathD(el.getAttribute("d") ?? "", tol);
  }
  if (tag === "polygon") {
    const raw = (el.getAttribute("points") ?? "").trim();
    if (!raw) return null;
    const pts: [number, number][] = [];
    const re = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
    const nums: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) nums.push(parseFloat(m[0]));
    for (let k = 0; k + 1 < nums.length; k += 2) pts.push([nums[k], nums[k + 1]]);
    return pts.length >= 3 ? [{ pts }] : null;
  }
  if (tag === "rect") {
    const p = rectPoly(el, tol);
    return p ? [p] : null;
  }
  if (tag === "circle") {
    const r = num(el, "r", 0);
    const p = ellipsePoly(num(el, "cx", 0), num(el, "cy", 0), r, r, tol);
    return p ? [p] : null;
  }
  if (tag === "ellipse") {
    const p = ellipsePoly(
      num(el, "cx", 0), num(el, "cy", 0),
      num(el, "rx", 0), num(el, "ry", 0), tol
    );
    return p ? [p] : null;
  }
  return null;
}

/** P7 (icon-fit): ALL geometry sample points of ONE painted leaf in its
 *  LOCAL coordinate system — BOUNDS semantics, not fill-measurement
 *  semantics: unlike elementPolys this INCLUDES open 2-point line subpaths
 *  of a <path> (an open line still paints stroke ink — the arrow stems the
 *  polygon output drops) and the endpoints of <line>/<polyline> (open
 *  shapes, elementPolys returns null for them). Returns null when the
 *  element carries no geometry at all. */
export function elementBoundsPts(
  el: Element,
  tol: number
): [number, number][] | null {
  const tag = el.localName?.toLowerCase() ?? "";
  if (tag === "path") {
    const open: [number, number][] = [];
    const polys = parsePathD(el.getAttribute("d") ?? "", tol, undefined, open) ?? [];
    const pts: [number, number][] = [];
    for (const p of polys) for (const pt of p.pts) pts.push(pt);
    for (const pt of open) pts.push(pt);
    return pts.length > 0 ? pts : null;
  }
  if (tag === "line") {
    const x1 = num(el, "x1", 0), y1 = num(el, "y1", 0);
    const x2 = num(el, "x2", 0), y2 = num(el, "y2", 0);
    return [[x1, y1], [x2, y2]];
  }
  if (tag === "polyline") {
    const raw = (el.getAttribute("points") ?? "").trim();
    if (!raw) return null;
    const pts: [number, number][] = [];
    const re = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
    const nums: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) nums.push(parseFloat(m[0]));
    for (let k = 0; k + 1 < nums.length; k += 2) pts.push([nums[k], nums[k + 1]]);
    return pts.length >= 2 ? pts : null;
  }
  /* closed shapes (polygon/rect/circle/ellipse) — the polygon output is
   * already complete for bounds. */
  const polys = elementPolys(el, tol);
  if (!polys) return null;
  const pts: [number, number][] = [];
  for (const p of polys) for (const pt of p.pts) pts.push(pt);
  return pts.length > 0 ? pts : null;
}

/* ------------------------------------------------------------------ */
/* Measurement primitives (area / perimeter — used by the per-band      */
/* outline measurement and the subpath classification below)           */
/* ------------------------------------------------------------------ */

function signedArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function perimeterClosed(pts: [number, number][]): number {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* Subpath structure analysis (measurement-only)                       */
/* ------------------------------------------------------------------ */

/** One subpath of a `d` attribute, kept as a VERBATIM substring of the
 *  original data plus its sampled measurement geometry. The substring is
 *  byte-exact source data — re-emitting selected subpaths never generates,
 *  offsets, flattens or rebuilds any geometry (curves stay curves; anchor
 *  counts never change). The sampled polygon comes from a FULL-`d` parse,
 *  so a subpath that starts with a relative 'm' (the standard editor
 *  output for "z m …" compound paths) is positioned at its TRUE absolute
 *  location. */
export interface SubpathSpan {
  /** verbatim source substring (starts at its own moveto command) */
  src: string;
  /** ends with an explicit closepath (z/Z). */
  closed: boolean;
  /** sampled polygon (fill semantics auto-close) — null when degenerate. */
  poly: Poly | null;
  /** |area| of the sampled polygon. */
  area: number;
  /** ABSOLUTE start point of the subpath (viewBox units) — a relative
   *  'm' start resolved through the whole-`d` parse. */
  start: [number, number];
  /** character index of the subpath's moveto within the source `d`. */
  startIndex: number;
}

/** Compact path-coordinate output (≤3 decimals, no trailing zeros). */
function coordFmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** Split a `d` attribute into its subpath spans (measurement + verbatim
 *  source extraction). Every moveto starts a new subpath; a span runs to
 *  the next moveto (or end of data). The spans and their sampled polygons
 *  come from ONE full-`d` parse, so relative-'m' subpath starts are
 *  positioned correctly (a standalone per-span parse would mis-place them
 *  — the old bug that made every "z m…" compound icon unmeasurable).
 *  Returns null for empty/unusable data. */
export function splitSubpaths(d: string, tol: number): SubpathSpan[] | null {
  if (!d) return null;
  const tracked: TrackedSubpath[] = [];
  parsePathD(d, tol, tracked);
  if (tracked.length === 0) return null;
  const spans: SubpathSpan[] = [];
  for (let i = 0; i < tracked.length; i++) {
    const from = tracked[i].startIndex;
    const to = i + 1 < tracked.length ? tracked[i + 1].startIndex : d.length;
    const src = d.slice(from, to);
    const poly = tracked[i].pts ? { pts: tracked[i].pts as [number, number][] } : null;
    spans.push({
      src,
      closed: /\s*[zZ]\s*$/.test(src),
      poly,
      area: poly ? Math.abs(signedArea(poly.pts)) : 0,
      start: tracked[i].start,
      startIndex: from,
    });
  }
  return spans;
}

/** STANDALONE-SAFE emission form of one subpath: when the span starts
 *  with an ABSOLUTE 'M' the verbatim source is returned untouched; when
 *  it starts with a relative 'm' (which would resolve against the
 *  previous subpath — and per the SVG spec an INITIAL moveto is absolute),
 *  the leading "m dx dy" is rewritten to "M x y" at the span's TRUE
 *  resolved start point. This is a pure moveto re-anchoring: the same
 *  point, the same subsequent commands, curves stay curves, anchor
 *  counts never change — it makes the span positionally independent so
 *  filtered/re-grouped emissions (band groups, solids groups) can never
 *  relocate geometry. Implicit coordinate pairs after the moveto keep
 *  their relative semantics (an explicit 'l' is inserted — after 'M' they
 *  would otherwise become absolute LINETO). Returns null only for
 *  malformed data (unparseable coordinate pair). */
export function spanStandaloneSrc(span: SubpathSpan): string | null {
  const src = span.src;
  if (src[0] !== "m") return src; // absolute 'M' (or degenerate) — already standalone
  const c: Cursor = { s: src, i: 1 };
  const dx = readNumber(c);
  const dy = dx == null ? null : readNumber(c);
  if (dx == null || dy == null) return null;
  const rest = src.slice(c.i);
  const restTrim = rest.replace(/^[\s,]*/, "");
  /* numbers follow the moveto pair → implicit repetition: under 'm' they
   * are relative LINETOs; re-anchored under 'M' they would flip absolute,
   * so an explicit 'l' preserves the exact original semantics. */
  const implicitLineTo = /^[-+.0-9]/.test(restTrim);
  return `M${coordFmt(span.start[0])} ${coordFmt(span.start[1])}${implicitLineTo ? "l" : ""}${rest}`;
}

/** Even-odd ray-casting point-in-polygon (measurement only). */
function pointInPoly(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Is `inner` (mostly) inside `outer`? Samples up to 12 vertices of the
 *  inner polygon; ≥ 85 % inside counts as containment (robust against
 *  flattening noise on shared boundaries). */
function containsPoly(outer: Poly, inner: Poly): boolean {
  const n = inner.pts.length;
  if (n < 3) return false;
  const step = Math.max(1, Math.floor(n / 12));
  let inside = 0;
  let total = 0;
  for (let k = 0; k < n; k += step) {
    const [x, y] = inner.pts[k];
    total++;
    if (pointInPoly(x, y, outer.pts)) inside++;
  }
  return total > 0 && inside / total >= 0.85;
}

/** Subpath structure of a compound outline leaf — which subpaths are the
 *  OUTER contours of outline bands, which are solid filled shapes, and
 *  which are holes (absence). Derived from the containment tree of the
 *  sampled subpath regions: a subpath at even tree depth whose region
 *  contains other subpaths is the outer contour of a band (the region
 *  between it and its direct children is what reads as the "line"); an
 *  even-depth subpath with no children is a solid fill; odd-depth
 *  subpaths are holes. Works for both fill rules (containment is purely
 *  geometric). MEASUREMENT ONLY — nothing here is emitted. */
export interface SubpathClassification {
  spans: SubpathSpan[];
  /** indices of closed even-depth subpaths that contain ≥ 1 other
   *  subpath — the outer contours of measurable outline bands. */
  outerIdx: number[];
  /** indices of even-depth subpaths with no children — solid fills that
   *  must keep rendering exactly as before (a solid shape has no outline
   *  to thin). Degenerate subpaths are kept here (rendered verbatim). */
  solidIdx: number[];
  /** parent[subpath] = index of the smallest subpath containing it
   *  (−1 at top level) — the containment tree the band grouping below
   *  walks. MEASUREMENT ONLY. */
  parent: number[];
}

const classifyCache = new Map<string, SubpathClassification | null>();
const CLASSIFY_CACHE_CAP = 2000;

/** Classify the subpath structure of a `d` attribute (cached — the same
 *  leaf is re-analyzed on every distinct stroke factor, so the structure
 *  work must happen once). Relative-'m' subpath starts are FULLY
 *  supported: measurement positions them via the whole-`d` parse and
 *  emission re-anchors them through spanStandaloneSrc, so they are no
 *  longer a safety limitation. Returns null only when the structure
 *  cannot be analyzed at all (no usable subpaths). */
export function classifySubpaths(d: string, tol: number): SubpathClassification | null {
  const key = `${tol}|${d.length}|${d}`;
  const cached = classifyCache.get(key);
  if (cached) {
    /* LRU refresh — the same leaf is re-classified on every distinct
     * stroke factor, so the structure work must happen once. */
    classifyCache.delete(key);
    classifyCache.set(key, cached);
    return cached;
  }
  const spans = splitSubpaths(d, tol);
  let result: SubpathClassification | null = null;
  if (spans && spans.length > 0) {
    const n = spans.length;
    const parent = new Array<number>(n).fill(-1);
    for (let j = 0; j < n; j++) {
      const pj = spans[j].poly;
      if (!pj) continue;
      let best = -1;
      let bestArea = Infinity;
      for (let i = 0; i < n; i++) {
        if (i === j) continue;
        const pi = spans[i].poly;
        if (!pi || spans[i].area <= spans[j].area) continue;
        if (containsPoly(pi, pj) && spans[i].area < bestArea) {
          best = i;
          bestArea = spans[i].area;
        }
      }
      parent[j] = best;
    }
    const depthOf = (i: number): number => {
      let d = 0;
      let p = parent[i];
      while (p !== -1) {
        d++;
        p = parent[p];
      }
      return d;
    };
    const hasChild = new Array<boolean>(n).fill(false);
    for (let j = 0; j < n; j++) {
      if (parent[j] !== -1) hasChild[parent[j]] = true;
    }
    const outerIdx: number[] = [];
    const solidIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      const depth = depthOf(i);
      if (depth % 2 === 0) {
        if (hasChild[i] && spans[i].closed && spans[i].poly) outerIdx.push(i);
        else solidIdx.push(i);
      }
      /* odd depth = hole — renders nothing (absence). */
    }
    result = { spans, outerIdx, solidIdx, parent };
  }
  if (classifyCache.size >= CLASSIFY_CACHE_CAP) {
    const oldest = classifyCache.keys().next().value;
    if (oldest !== undefined) classifyCache.delete(oldest);
  }
  classifyCache.set(key, result);
  return result;
}

/* ------------------------------------------------------------------ */
/* Per-band outline + per-solid measurement                             */
/* ------------------------------------------------------------------ */

/** ONE outline band of a compound leaf: an outer contour plus its DIRECT
 *  hole children — the closed region between them is what visually reads
 *  as a "line". `width` is the band's own measured thickness
 *      W = 2 · (A_outer − Σ A_holes) / (P_outer + Σ P_holes)
 *  (exact for bars L×W and rings R−r) — a PER-BAND measurement, never a
 *  leaf-global average, so leaves that mix bands of different weights
 *  (or bands with solids) measure each band at its own true width.
 *  MEASUREMENT ONLY — nothing here is emitted. */
export interface OutlineBand {
  /** span index of the band's outer contour. */
  outerIdx: number;
  /** span indices of the band's direct hole contours. */
  holeIdx: number[];
  /** measured band width in the element's LOCAL units (> 0). */
  width: number;
}

/** ONE measurable SOLID subshape of a fill leaf — a closed filled contour
 *  with no holes (silhouettes, limbs, bars, arrowheads, dots, and every
 *  primitive shape element). Real-world icon packs ship huge numbers of
 *  such "bold" marks: they read as THICK LINES (an outlined stroke), so
 *  weight requests must adjust them in BOTH directions — the styling
 *  engine erodes them to ONE single thinner line at factor·W (centerline
 *  kept, Illustrator stroke-reduction semantics) and dilates them around
 *  their own contour when growing. `width` uses the SAME T̂ = 2·A/P
 *  convention as bands (exact for bars; the mean chord for compact blobs
 *  — the mark's own visual weight).
 *  MEASUREMENT ONLY — nothing here is emitted. */
export interface SolidShape {
  /** span index of the solid's own contour; −1 = the ELEMENT ITSELF
   *  (primitive leaves: circle/rect/ellipse/polygon measure as ONE
   *  solid — their geometry is the whole leaf). */
  idx: number;
  /** measured width in the element's LOCAL units (> 0). */
  width: number;
  /** SHAPE-AWARE adjust multiplier (1…2) — how the mark's own contour
   *  structure responds to erosion/dilation, so EVERY solid lands its
   *  visible width multiplicatively on factor·W like a true stroke:
   *    · κ = 1 (stroke-like: capsules, bars) — the mark has two opposing
   *      long edges, so eroding/dilating by ρ per edge changes its width
   *      by 2ρ ⇒ erase/dilate stroke = (1−f)·W / (f−1)·W exactly;
   *    · κ = 2 (compact: dots, circles, squares, triangles) — the
   *      contour is a single boundary (the mark erodes/grows only from
   *      its own outline), so the SAME multiplicative landing needs
   *      twice the stroke width ⇒ a dot's DIAMETER lands on factor·D
   *      exactly like a bar's width lands on factor·W;
   *    · between (domes, arrowheads, silhouettes) — blended.
   *  κ = clamp(3 − 2·T̂/bboxShort, 1, 2): exact at both anchors
   *  (T̂ ≈ short side for long capsules; T̂ = short/2 for circles), a
   *  close fit in between (domes ~9%). MEASUREMENT ONLY. */
  kappa: number;
}

export interface ElementOutlineReport {
  classification: SubpathClassification;
  /** measurable outline bands (outer contour + direct holes). */
  bands: OutlineBand[];
  /** measurable SOLID subshapes (closed, area-bearing, no holes) —
   *  adjustable marks in BOTH directions: erosion thinning below ×1
   *  (ONE single thinner line at factor·W, centerline kept) and
   *  dilation growth above ×1 (paint-order stroke around their own
   *  contour). */
  solids: SolidShape[];
  /** the leaf's representative native width = its WIDEST band OR solid
   *  (the dominant look — solids are marks too, so they must count;
   *  0 when the leaf has neither). */
  representative: number;
}

/** T̂ = 2·A/P of ONE closed polygon — the width convention the whole
 *  engine shares (exact for bars, mean chord for blobs). null when the
 *  polygon is degenerate (no area / no perimeter). */
function solidWidthOf(pts: [number, number][]): number | null {
  const area = Math.abs(signedArea(pts));
  const per = perimeterClosed(pts);
  if (!(area > 0) || !(per > 0)) return null;
  const w = (2 * area) / per;
  return Number.isFinite(w) && w > 0 ? w : null;
}

/** Shape-aware solid multiplier κ (see SolidShape.kappa) from the solid's
 *  measured width and its sampled polygon's bbox short side. */
function solidKappaOf(width: number, pts: readonly [number, number][]): number {
  if (!(width > 0) || pts.length === 0) return 1;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const short = Math.min(maxX - minX, maxY - minY);
  if (!(short > 0) || !Number.isFinite(short)) return 1;
  const k = 3 - (2 * width) / short;
  return Math.min(2, Math.max(1, k));
}

/** Measure a fill leaf's OUTLINE structure band by band AND its solid
 *  subshapes one by one. Returns null when the subpath structure cannot
 *  be analyzed safely (unusable `d`) — the caller then keeps the element
 *  untouched (honest limitation, never a guess). Non-<path> leaves
 *  (circle/rect/polygon/ellipse) are single closed contours = ONE
 *  measurable solid (the element itself, idx −1). Open / degenerate
 *  subpaths measure nothing and stay verbatim at render time. */
export function measureElementOutline(
  el: Element,
  evenodd: boolean,
  tol: number
): ElementOutlineReport | null {
  void evenodd; /* containment is purely geometric — fill-rule agnostic */
  const tag = el.localName?.toLowerCase() ?? "";
  if (tag !== "path") {
    /* Primitive leaf — ONE solid (the element itself). */
    const polys = elementPolys(el, tol);
    const w = polys && polys.length === 1 ? solidWidthOf(polys[0].pts) : null;
    return {
      classification: { spans: [], outerIdx: [], solidIdx: [], parent: [] },
      bands: [],
      solids:
        w != null
          ? [{ idx: -1, width: w, kappa: solidKappaOf(w, polys![0]!.pts) }]
          : [],
      representative: w ?? 0,
    };
  }
  const d = el.getAttribute("d");
  if (!d) return null;
  const cls = classifySubpaths(d, tol);
  if (!cls) return null;
  const bands: OutlineBand[] = [];
  for (const o of cls.outerIdx) {
    const outer = cls.spans[o].poly;
    if (!outer) continue;
    const holeIdx: number[] = [];
    let area = cls.spans[o].area;
    let per = perimeterClosed(outer.pts);
    for (let j = 0; j < cls.parent.length; j++) {
      if (cls.parent[j] !== o) continue;
      const hole = cls.spans[j].poly;
      if (!hole) continue; /* degenerate hole — renders nothing */
      holeIdx.push(j);
      area -= cls.spans[j].area;
      per += perimeterClosed(hole.pts);
    }
    if (!(area > 0) || !(per > 0)) continue;
    const w = (2 * area) / per;
    if (Number.isFinite(w) && w > 0) bands.push({ outerIdx: o, holeIdx, width: w });
  }
  /* Measurable SOLIDS: closed, area-bearing solid subpaths — marks that
   *  adjust in BOTH directions (erosion thinning / dilation growth).
   *  Open / degenerate spans (zero area, unparseable) measure nothing
   *  here and keep rendering verbatim at render time. */
  const solids: SolidShape[] = [];
  for (const i of cls.solidIdx) {
    const span = cls.spans[i];
    if (!span.closed || !span.poly) continue;
    const w = solidWidthOf(span.poly.pts);
    if (w != null) solids.push({ idx: i, width: w, kappa: solidKappaOf(w, span.poly.pts) });
  }
  let representative = 0;
  for (const b of bands) representative = Math.max(representative, b.width);
  for (const s of solids) representative = Math.max(representative, s.width);
  return { classification: cls, bands, solids, representative };
}
