// A small car that chases the mouse pointer around the page. Every line of text
// and every image is an obstacle: the car plans a route with A* on an occupancy
// grid of the page, follows it with pure pursuit, and brakes as it nears the
// pointer. Desktop only, and it stops requesting frames whenever it is parked.
(() => {
    'use strict';

    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const canvas = document.createElement('canvas');
    canvas.id = 'car-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    document.body.appendChild(canvas);

    // ---------- Tunables (CSS px, seconds) ----------
    const CELL = 10;                 // occupancy grid resolution
    const CLEARANCE = 20;            // obstacles are inflated by this much for planning
    const EDGE_MARGIN = 14;          // keep the car off the very edges of the page
    const TILE = 128;                // spatial hash tile for exact obstacle queries

    const BODY_R = 7.5;              // the body is approximated by two circles,
    const BODY_OFFSET = 6;           // centred this far ahead of / behind the car's centre
    const WHEELBASE = 14;
    const NOSE = 13;                 // centre to front bumper

    const V_MAX = 450;
    const V_CORNER = 70;             // speed allowed through a hairpin
    const A_ACCEL = 650;
    const A_BRAKE = 600;
    const A_LAT = 1200;
    const OMEGA_MAX = 7;             // rad/s
    // Like a real car it can't turn on the spot: turning needs speed and is limited to
    // R_MIN. To turn hard it creeps forward on full lock; for a pointer close behind
    // it does a three-point turn, reversing with the wheels turned.
    const R_MIN = 26;                // px, tightest turning radius
    const V_CREEP = 90;              // px/s it keeps rolling at while turning hard
    const THREE_POINT_ANGLE = 1.75;  // rad off-heading, and
    const THREE_POINT_DIST = 110;    // px away or closer, before it reverses round
    const THREE_POINT_TIME = 1.2;    // max seconds of reversing
    const LOOK_MIN = 12, LOOK_GAIN = 0.06, LOOK_MAX = 44;
    const STOP_DIST = 2, RESTART_DIST = 14;
    const REVERSE_TIME = 0.3, REVERSE_SPEED = 60;
    const REPLAN_MS = 60, OFF_PATH = 28;

    // Drift: above DRIFT_START lateral acceleration the body swings into the turn,
    // reaching BETA_MAX by DRIFT_FULL, and the rear tyres leave fading skid marks.
    const BETA_MAX = 0.45;
    const DRIFT_START = 250, DRIFT_FULL = 900;
    const DRIFT_SCRUB = 420;         // px/s² of speed lost to sideways scrub at full drift
    const DRIFT_TRACTION = 0.8;      // fraction of acceleration lost at full drift
    const DRIFT_SLIDE = 0.2;        // sideways slide speed, as a fraction of speed, at full drift
    const MARK_MIN_BETA = 0.1;
    const MARK_LIFE = 1.8;           // seconds for a skid mark to fade out
    const MARK_CAP = 1024;           // ring buffer of mark segments
    const MARK_ALPHA = 0.32;
    const MARK_BUCKETS = 6;          // marks are batched into this many opacity levels

    // Smooth noise so drifts and skid marks don't look machine-perfect.
    const DRIFT_WOBBLE = 0.07;       // rad of tail wobble at full drift
    const DRIFT_WOBBLE_HZ = 2.2;
    const DRIFT_VARIETY = 0.15;      // how much the drift depth varies from corner to corner
    const MARK_JITTER = 0.7;         // px of sideways wander in the tyre marks
    const MARK_PATCHY = 0.4;         // how much mark darkness varies along the trail

    // Headlights: two short, soft beams from the front corners.
    const BEAM_LEN = 30;
    const BEAM_HALF = 0.32;          // rad

    // Nitro boost: when the pointer is far away and the road ahead is clear, a short
    // burst adds acceleration and top speed, shown by exhaust flames and sparks.
    const BOOST_MIN_DIST = 450;      // px of route left before a boost can fire
    const BOOST_TIME = 0.6;          // seconds
    const BOOST_ACCEL = 2.2;         // acceleration multiplier while boosting
    const V_BOOST = 720;             // top speed while boosting
    const BOOST_COOLDOWN = 2;        // seconds after a boost before the next one
    const COAST_DECEL = 380;         // px/s² easing back to normal top speed afterwards
    // Overshoot: arriving fast on a clear final straight, the car brakes late, skids
    // past the pointer while its tail swings round to face it, then drives back.
    const OVERSHOOT_MIN_V = 400;     // px/s needed on the run-in
    // Each overshoot picks its own run-in braking and skid friction (so its length
    // varies) and its own arc radius; a few candidates are tried and the first whose
    // whole slide is clear is used, falling back to a straight slide.
    const LATE_BRAKE_MIN = 140, LATE_BRAKE_MAX = 420;      // px/s² on the run-in
    const SKID_DECEL_MIN = 650, SKID_DECEL_MAX = 1000;     // px/s² while skidding
    const SKID_RADIUS_MIN = 70, SKID_RADIUS_MAX = 240;     // px, radius of the skid's arc
    const SKID_TRIES = 3;
    const SPIN_RATE = 6;             // rad/s the body swings round during the skid
    const SKID_MARGIN = 20;          // clear distance required beyond the skid
    const SPARK_CAP = 160;
    const SPARK_LIFE = 0.35;         // seconds
    const SPARK_RATE = 70;           // sparks per second at full nitro
    const SPARK_BUCKETS = 4;

    const COLORS = {
        body: '#7c3aed',
        glass: '#2e1065',
        glassRear: '#4c1d95',
        roof: 'rgba(255, 255, 255, 0.18)',
        wheel: '#1c1917',
        head: '#fef3c7',
        brake: '#ef4444',
        tail: '#7f1d1d',
        shadow: 'rgba(17, 12, 46, 0.18)',
        beamNear: 'rgba(253, 224, 71, 0.55)',
        beamFar: 'rgba(253, 224, 71, 0)',
    };

    const SQRT2 = Math.SQRT2;
    const DX = [1, -1, 0, 0, 1, 1, -1, -1];
    const DY = [0, 0, 1, -1, 1, -1, 1, -1];
    const COST = [1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2];
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'OPTION']);

    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const rand = (lo, hi) => lo + Math.random() * (hi - lo);
    const wrap = (a) => {
        while (a > Math.PI) a -= 2 * Math.PI;
        while (a < -Math.PI) a += 2 * Math.PI;
        return a;
    };

    // Smooth 1D value noise in [-1, 1]. Offsetting x gives independent streams.
    const hash = (n) => {
        const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
        return s - Math.floor(s);
    };
    function noise1(x) {
        const i = Math.floor(x);
        const f = x - i;
        const u = f * f * (3 - 2 * f);
        const a = hash(i);
        return (a + (hash(i + 1) - a) * u) * 2 - 1;
    }

    // ---------- State ----------
    // th is the direction of travel; beta is the drift angle the body is swung by.
    const car = { x: 0, y: 0, th: -Math.PI / 2, beta: 0, v: 0, steer: 0, nitro: 0, braking: false, parked: true };
    const target = { x: 0, y: 0 };
    const pointer = { x: 0, y: 0, seen: false };
    const stats = { frames: 0, frameMsTotal: 0, frameMsMax: 0, plans: 0, planMs: 0, planMsMax: 0, rebuilds: 0, rebuildMs: 0, bumps: 0, rects: 0, betaMax: 0, marks: 0, nitroMax: 0, boosts: 0, vMax: 0, overshoots: 0, skids: 0, threePoints: 0 };

    // Obstacles: axis-aligned boxes in document coordinates, [x0, y0, x1, y1] * n.
    let rects = new Float64Array(0);
    let rectCount = 0;
    let tiles = [];
    let tilesX = 0;
    let tilesY = 0;
    let rectSeen = new Uint32Array(0);
    let queryId = 0;
    let near = new Int32Array(64);

    // Occupancy grid over the whole document, plus reusable A* buffers.
    let gw = 0;
    let gh = 0;
    let worldW = 1;
    let worldH = 1;
    let blocked = new Uint8Array(0);
    let gScore = new Float32Array(0);
    let cameFrom = new Int32Array(0);
    let openStamp = new Uint32Array(0);
    let closedStamp = new Uint32Array(0);
    let searchId = 0;
    let pathCells = new Int32Array(0);
    let pathLen = 0;
    let heapNodes = new Int32Array(1024);
    let heapKeys = new Float64Array(1024);
    let heapSize = 0;

    // Raw A* waypoints and the smoothed path the car actually follows.
    let rawX = new Float64Array(64);
    let rawY = new Float64Array(64);
    let rawN = 0;
    let px = new Float64Array(64);
    let py = new Float64Array(64);
    let cum = new Float64Array(64);
    let pathN = 0;
    let seg = 0;
    let plannedCell = -1;
    let exactGoal = false;
    let needReplan = true;
    let lastPlanAt = -Infinity;
    let reverseT = 0;
    let threePoint = false;          // reversing as part of a three-point turn (vs. after a bump)
    let threePointBlockedUntil = 0;
    let boostT = 0;                  // seconds of boost left
    let boostCool = 0;               // seconds until another boost may fire
    const DRIVE = 0, LATE_BRAKING = 1, SKIDDING = 2;
    let mode = DRIVE;
    let hotPlans = 0;                // plan count when late braking began (a replan cancels it)
    let spinDir = 1;                 // side the skid arcs and the body swings towards
    let lateBrake = 0;               // this overshoot's run-in braking, skid friction
    let skidDecel = 0;
    let skidCurv = 0;                // and arc curvature (1 / radius; 0 = straight)

    // Per-frame tracking results (module-level to avoid allocating every frame).
    let tRemaining = 0;
    let tAlong = 0;                  // distance left measured along the path only
    let tAlpha = 0;
    let tKappa = 0;
    let tVLim = 0;
    let tCross = 0;
    let lookX = 0;
    let lookY = 0;

    // ---------- Obstacle extraction ----------
    function clipContainers() {
        const clips = new Map();
        for (const el of document.body.querySelectorAll('*')) {
            if (el === canvas) continue;
            if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) continue;
            if (!el.clientHeight && !el.clientWidth) continue;
            const cs = getComputedStyle(el);
            if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
            clips.set(el, el.getBoundingClientRect());
        }
        return clips;
    }

    function collectRects() {
        const out = [];
        const sx = window.scrollX;
        const sy = window.scrollY;
        const clips = clipContainers();

        // Text scrolled out of view inside a scroll box (e.g. the news list) is clipped away.
        const clipFor = (el) => {
            if (!clips.size) return null;
            let c = null;
            for (let e = el; e && e !== document.body; e = e.parentElement) {
                const r = clips.get(e);
                if (!r) continue;
                c = c
                    ? { left: Math.max(c.left, r.left), top: Math.max(c.top, r.top), right: Math.min(c.right, r.right), bottom: Math.min(c.bottom, r.bottom) }
                    : r;
            }
            return c;
        };
        const add = (r, c) => {
            let x0 = r.left;
            let y0 = r.top;
            let x1 = r.right;
            let y1 = r.bottom;
            if (c) {
                x0 = Math.max(x0, c.left);
                y0 = Math.max(y0, c.top);
                x1 = Math.min(x1, c.right);
                y1 = Math.min(y1, c.bottom);
            }
            if (x1 - x0 < 1 || y1 - y0 < 1) return;
            out.push(x0 + sx, y0 + sy, x1 + sx, y1 + sy);
        };

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const p = node.parentElement;
                if (!p || SKIP_TAGS.has(p.tagName) || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                if (p.checkVisibility && !p.checkVisibility({ visibilityProperty: true })) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        const range = document.createRange();
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            range.selectNodeContents(node);
            const c = clipFor(node.parentElement);
            for (const r of range.getClientRects()) add(r, c);
        }

        // Images and icon glyphs; the hero banner is background, so it stays drivable.
        for (const el of document.body.querySelectorAll('img, i[class*="fa-"]')) {
            if (el.closest('.bg-image')) continue;
            add(el.getBoundingClientRect(), clipFor(el));
        }
        return out;
    }

    function allocGrid(n) {
        blocked = new Uint8Array(n);
        gScore = new Float32Array(n);
        cameFrom = new Int32Array(n);
        openStamp = new Uint32Array(n);
        closedStamp = new Uint32Array(n);
        pathCells = new Int32Array(n);
    }

    function markBox(x0, y0, x1, y1) {
        const i0 = Math.max(0, Math.ceil(x0 / CELL - 0.5));
        const i1 = Math.min(gw - 1, Math.floor(x1 / CELL - 0.5));
        const j0 = Math.max(0, Math.ceil(y0 / CELL - 0.5));
        const j1 = Math.min(gh - 1, Math.floor(y1 / CELL - 0.5));
        if (i0 > i1) return;
        for (let j = j0; j <= j1; j++) blocked.fill(1, j * gw + i0, j * gw + i1 + 1);
    }

    function buildTiles() {
        tilesX = Math.max(1, Math.ceil(worldW / TILE));
        tilesY = Math.max(1, Math.ceil(worldH / TILE));
        tiles = Array.from({ length: tilesX * tilesY }, () => []);
        for (let k = 0; k < rectCount; k++) {
            const b = k * 4;
            const tx0 = clamp(Math.floor(rects[b] / TILE), 0, tilesX - 1);
            const tx1 = clamp(Math.floor(rects[b + 2] / TILE), 0, tilesX - 1);
            const ty0 = clamp(Math.floor(rects[b + 1] / TILE), 0, tilesY - 1);
            const ty1 = clamp(Math.floor(rects[b + 3] / TILE), 0, tilesY - 1);
            for (let ty = ty0; ty <= ty1; ty++) {
                for (let tx = tx0; tx <= tx1; tx++) tiles[ty * tilesX + tx].push(k);
            }
        }
        if (rectSeen.length < rectCount) rectSeen = new Uint32Array(rectCount);
        if (near.length < rectCount) near = new Int32Array(rectCount);
    }

    function rebuild() {
        const t0 = performance.now();
        const list = collectRects();
        rectCount = list.length / 4;
        rects = Float64Array.from(list);

        worldW = Math.max(1, document.documentElement.scrollWidth);
        worldH = Math.max(1, document.documentElement.scrollHeight);
        const nw = Math.ceil(worldW / CELL);
        const nh = Math.ceil(worldH / CELL);
        if (nw * nh !== blocked.length) allocGrid(nw * nh);
        gw = nw;
        gh = nh;
        blocked.fill(0);

        markBox(-CELL, -CELL, EDGE_MARGIN, worldH + CELL);
        markBox(worldW - EDGE_MARGIN, -CELL, worldW + CELL, worldH + CELL);
        markBox(-CELL, -CELL, worldW + CELL, EDGE_MARGIN);
        markBox(-CELL, worldH - EDGE_MARGIN, worldW + CELL, worldH + CELL);
        for (let k = 0; k < rectCount; k++) {
            const b = k * 4;
            markBox(rects[b] - CLEARANCE, rects[b + 1] - CLEARANCE, rects[b + 2] + CLEARANCE, rects[b + 3] + CLEARANCE);
        }
        buildTiles();

        needReplan = true;
        stats.rebuilds++;
        stats.rects = rectCount;
        stats.rebuildMs = performance.now() - t0;
    }

    // ---------- Exact geometry queries ----------
    function gatherNear(x0, y0, x1, y1) {
        const tx0 = clamp(Math.floor(x0 / TILE), 0, tilesX - 1);
        const tx1 = clamp(Math.floor(x1 / TILE), 0, tilesX - 1);
        const ty0 = clamp(Math.floor(y0 / TILE), 0, tilesY - 1);
        const ty1 = clamp(Math.floor(y1 / TILE), 0, tilesY - 1);
        queryId++;
        let n = 0;
        for (let ty = ty0; ty <= ty1; ty++) {
            for (let tx = tx0; tx <= tx1; tx++) {
                const list = tiles[ty * tilesX + tx];
                for (let k = 0; k < list.length; k++) {
                    const idx = list[k];
                    if (rectSeen[idx] === queryId) continue;
                    rectSeen[idx] = queryId;
                    near[n++] = idx;
                }
            }
        }
        return n;
    }

    function circleHits(cx, cy, b, r2) {
        const dx = Math.max(rects[b] - cx, 0, cx - rects[b + 2]);
        const dy = Math.max(rects[b + 1] - cy, 0, cy - rects[b + 3]);
        return dx * dx + dy * dy < r2;
    }

    function poseCollides(x, y, th) {
        const c = Math.cos(th) * BODY_OFFSET;
        const s = Math.sin(th) * BODY_OFFSET;
        const reach = BODY_OFFSET + BODY_R;
        const n = gatherNear(x - reach, y - reach, x + reach, y + reach);
        const r2 = BODY_R * BODY_R;
        for (let k = 0; k < n; k++) {
            const b = near[k] * 4;
            if (circleHits(x + c, y + s, b, r2) || circleHits(x - c, y - s, b, r2)) return true;
        }
        return false;
    }

    // ---------- Grid planning ----------
    const cellOf = (x, y) => clamp(Math.floor(y / CELL), 0, gh - 1) * gw + clamp(Math.floor(x / CELL), 0, gw - 1);
    const cellCx = (c) => ((c % gw) + 0.5) * CELL;
    const cellCy = (c) => (Math.floor(c / gw) + 0.5) * CELL;
    const isBlocked = (i, j) => i < 0 || j < 0 || i >= gw || j >= gh || blocked[j * gw + i] === 1;

    function nearestFree(x, y, maxR) {
        const ci = clamp(Math.floor(x / CELL), 0, gw - 1);
        const cj = clamp(Math.floor(y / CELL), 0, gh - 1);
        if (!blocked[cj * gw + ci]) return cj * gw + ci;
        let best = -1;
        let bestD2 = Infinity;
        const tryCell = (i, j) => {
            if (i < 0 || j < 0 || i >= gw || j >= gh || blocked[j * gw + i]) return;
            const dx = (i + 0.5) * CELL - x;
            const dy = (j + 0.5) * CELL - y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) { bestD2 = d2; best = j * gw + i; }
        };
        for (let r = 1; r <= maxR; r++) {
            const ringMin = (r - 0.5) * CELL;
            if (best >= 0 && ringMin * ringMin > bestD2) break;
            for (let k = -r; k <= r; k++) {
                tryCell(ci + k, cj - r);
                tryCell(ci + k, cj + r);
                if (k !== -r && k !== r) {
                    tryCell(ci - r, cj + k);
                    tryCell(ci + r, cj + k);
                }
            }
        }
        return best;
    }

    function heapPush(node, key) {
        if (heapSize === heapNodes.length) {
            const n = new Int32Array(heapSize * 2);
            n.set(heapNodes);
            heapNodes = n;
            const k = new Float64Array(heapSize * 2);
            k.set(heapKeys);
            heapKeys = k;
        }
        let i = heapSize++;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (heapKeys[p] <= key) break;
            heapNodes[i] = heapNodes[p];
            heapKeys[i] = heapKeys[p];
            i = p;
        }
        heapNodes[i] = node;
        heapKeys[i] = key;
    }

    function heapPop() {
        const top = heapNodes[0];
        heapSize--;
        const lastN = heapNodes[heapSize];
        const lastK = heapKeys[heapSize];
        let i = 0;
        for (;;) {
            const l = 2 * i + 1;
            if (l >= heapSize) break;
            const r = l + 1;
            const m = r < heapSize && heapKeys[r] < heapKeys[l] ? r : l;
            if (heapKeys[m] >= lastK) break;
            heapNodes[i] = heapNodes[m];
            heapKeys[i] = heapKeys[m];
            i = m;
        }
        heapNodes[i] = lastN;
        heapKeys[i] = lastK;
        return top;
    }

    // 8-connected A* with an octile heuristic and no corner cutting. If the goal is
    // unreachable it returns the explored cell closest to it. The path is left in
    // pathCells[0..pathLen) from goal back to start.
    function astar(start, goal) {
        searchId++;
        const gx = goal % gw;
        const gy = Math.floor(goal / gw);
        const heur = (c) => {
            const dx = Math.abs((c % gw) - gx);
            const dy = Math.abs(Math.floor(c / gw) - gy);
            return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
        };

        heapSize = 0;
        gScore[start] = 0;
        cameFrom[start] = -1;
        openStamp[start] = searchId;
        heapPush(start, heur(start));
        let best = start;
        let bestH = heur(start);

        while (heapSize > 0) {
            const cur = heapPop();
            if (closedStamp[cur] === searchId) continue;
            closedStamp[cur] = searchId;
            if (cur === goal) { best = cur; break; }
            const hc = heur(cur);
            if (hc < bestH) { bestH = hc; best = cur; }

            const cx = cur % gw;
            const cy = Math.floor(cur / gw);
            const gc = gScore[cur];
            for (let d = 0; d < 8; d++) {
                const nx = cx + DX[d];
                const ny = cy + DY[d];
                if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
                const nb = ny * gw + nx;
                if (blocked[nb] || closedStamp[nb] === searchId) continue;
                if (d >= 4 && (blocked[cy * gw + nx] || blocked[ny * gw + cx])) continue;
                const ng = gc + COST[d];
                if (openStamp[nb] === searchId && ng >= gScore[nb]) continue;
                openStamp[nb] = searchId;
                gScore[nb] = ng;
                cameFrom[nb] = cur;
                heapPush(nb, ng + heur(nb) * 1.001);
            }
        }

        pathLen = 0;
        for (let c = best; c !== -1; c = cameFrom[c]) pathCells[pathLen++] = c;
        return best;
    }

    // Grid line-of-sight via a DDA walk; squeezing diagonally between two blocked cells counts as blocked.
    function lineOfSight(x0, y0, x1, y1) {
        let i = Math.floor(x0 / CELL);
        let j = Math.floor(y0 / CELL);
        const iEnd = Math.floor(x1 / CELL);
        const jEnd = Math.floor(y1 / CELL);
        if (isBlocked(i, j)) return false;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const stepI = dx > 0 ? 1 : -1;
        const stepJ = dy > 0 ? 1 : -1;
        const tDeltaX = dx !== 0 ? Math.abs(CELL / dx) : Infinity;
        const tDeltaY = dy !== 0 ? Math.abs(CELL / dy) : Infinity;
        let tMaxX = dx !== 0 ? ((stepI > 0 ? (i + 1) * CELL : i * CELL) - x0) / dx : Infinity;
        let tMaxY = dy !== 0 ? ((stepJ > 0 ? (j + 1) * CELL : j * CELL) - y0) / dy : Infinity;
        let guard = Math.abs(iEnd - i) + Math.abs(jEnd - j) + 2;
        while ((i !== iEnd || j !== jEnd) && guard-- > 0) {
            if (Math.abs(tMaxX - tMaxY) < 1e-9) {
                if (isBlocked(i + stepI, j) || isBlocked(i, j + stepJ)) return false;
                i += stepI;
                j += stepJ;
                tMaxX += tDeltaX;
                tMaxY += tDeltaY;
            } else if (tMaxX < tMaxY) {
                i += stepI;
                tMaxX += tDeltaX;
            } else {
                j += stepJ;
                tMaxY += tDeltaY;
            }
            if (isBlocked(i, j)) return false;
        }
        return true;
    }

    function ensurePathCapacity(n) {
        if (rawX.length >= n) return;
        const size = Math.max(n, rawX.length * 2);
        rawX = new Float64Array(size);
        rawY = new Float64Array(size);
        px = new Float64Array(size);
        py = new Float64Array(size);
        cum = new Float64Array(size);
    }

    function pushRaw(x, y) {
        rawX[rawN] = x;
        rawY[rawN] = y;
        rawN++;
    }

    function pushPath(x, y) {
        px[pathN] = x;
        py[pathN] = y;
        cum[pathN] = pathN === 0 ? 0 : cum[pathN - 1] + Math.hypot(x - px[pathN - 1], y - py[pathN - 1]);
        pathN++;
    }

    // Greedy string pulling: from each anchor, skip ahead while the grid has line of sight.
    function smoothRaw() {
        pathN = 0;
        pushPath(rawX[0], rawY[0]);
        let i = 0;
        while (i < rawN - 1) {
            let j = i + 1;
            while (j + 1 < rawN && lineOfSight(rawX[i], rawY[i], rawX[j + 1], rawY[j + 1])) j++;
            pushPath(rawX[j], rawY[j]);
            i = j;
        }
    }

    function plan(now) {
        const t0 = performance.now();
        needReplan = false;
        lastPlanAt = now;
        const tc = cellOf(target.x, target.y);
        plannedCell = tc;
        exactGoal = false;

        const start = nearestFree(car.x, car.y, 30);
        const goal = nearestFree(target.x, target.y, 150);
        pathLen = 0;
        if (start >= 0 && goal >= 0) {
            if (start === goal) {
                pathCells[0] = start;
                pathLen = 1;
            } else {
                astar(start, goal);
            }
        }

        ensurePathCapacity(pathLen + 4);
        rawN = 0;
        pushRaw(car.x, car.y);
        const carCell = cellOf(car.x, car.y);
        for (let k = pathLen - 1; k >= 0; k--) {
            const c = pathCells[k];
            if (k === pathLen - 1 && c === carCell) continue;
            pushRaw(cellCx(c), cellCy(c));
        }
        // When the pointer sits in free space (and we reached it), aim at it exactly.
        if (pathLen > 0 && pathCells[0] === goal && goal === tc) {
            if (rawN > 1) {
                rawX[rawN - 1] = target.x;
                rawY[rawN - 1] = target.y;
            } else {
                pushRaw(target.x, target.y);
            }
            exactGoal = true;
        }
        if (rawN === 1) pushRaw(car.x, car.y);

        smoothRaw();
        seg = 0;

        stats.plans++;
        stats.planMs = performance.now() - t0;
        if (stats.planMs > stats.planMsMax) stats.planMsMax = stats.planMs;
    }

    function setLastPoint(x, y) {
        const k = pathN - 1;
        px[k] = x;
        py[k] = y;
        cum[k] = cum[k - 1] + Math.hypot(x - px[k - 1], y - py[k - 1]);
    }

    // ---------- Path tracking (pure pursuit + speed profile) ----------
    function pointAt(s) {
        let k = seg;
        while (k < pathN - 2 && cum[k + 1] < s) k++;
        const len = cum[k + 1] - cum[k];
        const t = len > 1e-9 ? clamp((s - cum[k]) / len, 0, 1) : 1;
        lookX = px[k] + (px[k + 1] - px[k]) * t;
        lookY = py[k] + (py[k + 1] - py[k]) * t;
    }

    function trackPath() {
        // Project the car onto the next few segments to measure progress.
        let bestD2 = Infinity;
        let bestSeg = seg;
        let bestT = 0;
        const lastSeg = Math.min(pathN - 2, seg + 3);
        for (let s = seg; s <= lastSeg; s++) {
            const ax = px[s];
            const ay = py[s];
            const dx = px[s + 1] - ax;
            const dy = py[s + 1] - ay;
            const l2 = dx * dx + dy * dy;
            const t = l2 > 0 ? clamp(((car.x - ax) * dx + (car.y - ay) * dy) / l2, 0, 1) : 0;
            const qx = ax + dx * t - car.x;
            const qy = ay + dy * t - car.y;
            const d2 = qx * qx + qy * qy;
            if (d2 < bestD2) { bestD2 = d2; bestSeg = s; bestT = t; }
        }
        seg = bestSeg;
        const sCar = cum[seg] + bestT * (cum[seg + 1] - cum[seg]);
        const total = cum[pathN - 1];
        tAlong = Math.max(0, total - sCar);
        // Never less than the straight-line distance: a car that can't steer onto the
        // end point (it's inside the turning circle) mustn't think it has arrived.
        tRemaining = Math.max(tAlong, Math.hypot(px[pathN - 1] - car.x, py[pathN - 1] - car.y));
        tCross = Math.sqrt(bestD2);

        // Braking profile to the goal, plus slowing for upcoming corners.
        let vLim = Math.sqrt(2 * A_BRAKE * Math.max(0, tRemaining - STOP_DIST));
        for (let k = seg + 1; k < pathN - 1 && k <= seg + 4; k++) {
            const ax = px[k] - px[k - 1];
            const ay = py[k] - py[k - 1];
            const bx = px[k + 1] - px[k];
            const by = py[k + 1] - py[k];
            const la = Math.hypot(ax, ay);
            const lb = Math.hypot(bx, by);
            const cosT = la > 1e-9 && lb > 1e-9 ? (ax * bx + ay * by) / (la * lb) : 1;
            const f = (1 + cosT) / 2;
            const vc = V_CORNER + (V_MAX - V_CORNER) * f * f;
            const d = Math.max(0, cum[k] - sCar);
            vLim = Math.min(vLim, Math.sqrt(vc * vc + 2 * A_BRAKE * d));
        }
        tVLim = vLim;                // the top-speed cap is applied in update()

        const look = clamp(LOOK_MIN + LOOK_GAIN * car.v, LOOK_MIN, LOOK_MAX);
        pointAt(Math.min(sCar + look, total));
        const ex = lookX - car.x;
        const ey = lookY - car.y;
        const dist = Math.hypot(ex, ey);
        if (dist > 1e-6) {
            tAlpha = wrap(Math.atan2(ey, ex) - car.th);
            tKappa = (2 * Math.sin(tAlpha)) / Math.max(dist, 1);
        } else {
            tAlpha = 0;
            tKappa = 0;
        }
    }

    // True if (x, y) lies inside one of the car's tightest turning circles, so it
    // can't be reached by driving forwards.
    function insideTurningCircle(x, y) {
        const dx = x - car.x;
        const dy = y - car.y;
        const c = Math.cos(car.th);
        const s = Math.sin(car.th);
        const fwd = dx * c + dy * s;
        const side = Math.abs(dy * c - dx * s);
        return fwd * fwd + (side - R_MIN) * (side - R_MIN) < R_MIN * R_MIN;
    }

    // Moves the car (with drift angle nb) unless that would take the body, as drawn,
    // from clear space into an obstacle. Drift is cosmetic, so it is reduced or
    // dropped before the move itself is refused.
    // slide is a sideways speed (px/s, positive = to the right of travel) from the
    // car's momentum carrying it wide through a drift.
    const DRIFT_FALLBACK = [1, 0.5, 0];
    function moveCar(speed, omega, dt, nb, slide) {
        const nth = wrap(car.th + omega * dt);
        const fx = Math.cos(nth);
        const fy = Math.sin(nth);
        if (poseCollides(car.x, car.y, car.th + car.beta)) {
            // Already overlapping (e.g. the layout shifted under the car): move freely to escape.
            car.x = clamp(car.x + (speed * fx - slide * fy) * dt, 0, worldW);
            car.y = clamp(car.y + (speed * fy + slide * fx) * dt, 0, worldH);
            car.th = nth;
            car.beta = nb;
            return true;
        }
        for (let k = 0; k < DRIFT_FALLBACK.length; k++) {
            const f = DRIFT_FALLBACK[k];
            if (f !== 1 && nb === 0 && slide === 0) break;
            const s = slide * f;
            const nx = car.x + (speed * fx - s * fy) * dt;
            const ny = car.y + (speed * fy + s * fx) * dt;
            if (poseCollides(nx, ny, nth + nb * f)) continue;
            car.x = clamp(nx, 0, worldW);
            car.y = clamp(ny, 0, worldH);
            car.th = nth;
            car.beta = nb * f;
            return true;
        }
        // Blocked: turn on the spot if there's room, straightening up if needed.
        if (!poseCollides(car.x, car.y, nth + car.beta)) {
            car.th = nth;
        } else if (!poseCollides(car.x, car.y, nth)) {
            car.th = nth;
            car.beta = 0;
        }
        return false;
    }

    function relaxedBeta(dt) {
        return car.beta * Math.max(0, 1 - dt * 6);
    }

    // Front wheels follow the turn normally and counter-steer as the drift builds.
    function steerVisual(omega, v, dt) {
        const vv = Math.abs(v) < 40 ? (v < 0 ? -40 : 40) : v;
        const turn = Math.atan((omega * WHEELBASE) / vv);
        const d = Math.min(1, Math.abs(car.beta) / BETA_MAX);
        const want = clamp(turn * (1 - d) - car.beta * 1.3 * d, -0.55, 0.55);
        car.steer += (want - car.steer) * Math.min(1, dt * 14);
    }

    // ---------- Skid marks (document coordinates, ring buffer) ----------
    const marks = new Float64Array(MARK_CAP * 6);    // x0, y0, x1, y1, time, strength
    let markHead = 0;
    let markCount = 0;
    const prevWheel = new Float64Array(4);
    let prevWheelValid = false;

    function pushMark(x0, y0, x1, y1, t, strength) {
        const i = markHead * 6;
        marks[i] = x0;
        marks[i + 1] = y0;
        marks[i + 2] = x1;
        marks[i + 3] = y1;
        marks[i + 4] = t;
        marks[i + 5] = strength;
        markHead = (markHead + 1) % MARK_CAP;
        if (markCount < MARK_CAP) markCount++;
    }

    function emitMarks(now) {
        const strength = clamp((Math.abs(car.beta) - MARK_MIN_BETA) / (BETA_MAX - MARK_MIN_BETA), 0, 1);
        if (strength <= 0 || car.v < 60) {
            prevWheelValid = false;
            return;
        }
        // Rear wheels sit at (-7, ±6) in the body frame; each tyre wanders and
        // varies in darkness on its own smooth noise stream.
        const yaw = car.th + car.beta;
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        const t = now / 1000;
        const lx = car.x - 7 * c + 6 * s + MARK_JITTER * noise1(t * 14 + 300);
        const ly = car.y - 7 * s - 6 * c + MARK_JITTER * noise1(t * 14 + 400);
        const rx = car.x - 7 * c - 6 * s + MARK_JITTER * noise1(t * 14 + 500);
        const ry = car.y - 7 * s + 6 * c + MARK_JITTER * noise1(t * 14 + 600);
        if (prevWheelValid) {
            const ls = strength * (1 - MARK_PATCHY * (0.5 + 0.5 * noise1(t * 9 + 700)));
            const rs = strength * (1 - MARK_PATCHY * (0.5 + 0.5 * noise1(t * 9 + 800)));
            pushMark(prevWheel[0], prevWheel[1], lx, ly, t, ls);
            pushMark(prevWheel[2], prevWheel[3], rx, ry, t, rs);
        }
        prevWheel[0] = lx;
        prevWheel[1] = ly;
        prevWheel[2] = rx;
        prevWheel[3] = ry;
        prevWheelValid = true;
    }

    // Returns true while there is more to animate.
    function update(dt, now) {
        if (pointer.seen) {
            target.x = clamp(pointer.x + window.scrollX, 1, worldW - 1);
            target.y = clamp(pointer.y + window.scrollY, 1, worldH - 1);
        }
        const tc = cellOf(target.x, target.y);
        const wantPlan = needReplan || tc !== plannedCell;
        if (wantPlan && now - lastPlanAt >= REPLAN_MS) plan(now);
        else if (!wantPlan && exactGoal) setLastPoint(target.x, target.y);
        const planPending = needReplan || tc !== plannedCell;

        trackPath();
        if (tCross > OFF_PATH) needReplan = true;

        if (reverseT > 0) {
            // Backing up with the wheels turned swings the nose towards where it wants to go.
            reverseT -= dt;
            const omega = (Math.sign(tAlpha) * REVERSE_SPEED) / R_MIN;
            if (!moveCar(-REVERSE_SPEED, omega, dt, relaxedBeta(dt), 0)) {
                reverseT = 0;
                if (threePoint) threePointBlockedUntil = now + 1000;   // no room behind: arc forward instead
            }
            if (threePoint && Math.abs(tAlpha) < 0.9 && !insideTurningCircle(px[pathN - 1], py[pathN - 1])) reverseT = 0;
            if (reverseT <= 0) {
                threePoint = false;
                needReplan = true;
            }
            steerVisual(omega, -REVERSE_SPEED, dt);
            prevWheelValid = false;
            car.v = 0;
            car.nitro = 0;
            boostT = 0;
            mode = DRIVE;
            car.braking = false;
            return true;
        }

        // A replan (the pointer moved) cancels a late-braking run-in; reaching the
        // pointer while still late braking starts the skid past it.
        if (mode === LATE_BRAKING && stats.plans !== hotPlans) mode = DRIVE;
        if (mode === LATE_BRAKING && tAlong <= 1) startSkid();
        if (mode === SKIDDING) return skid(dt, now);

        if (car.parked) {
            if (tRemaining <= RESTART_DIST) {
                car.v = 0;
                car.nitro = 0;
                car.braking = false;
                return settle(dt) || planPending || needReplan;
            }
            car.parked = false;
        }
        if (tRemaining <= STOP_DIST + 0.5 && car.v < 40) {
            car.parked = true;
            car.v = 0;
            car.nitro = 0;
            boostT = 0;
            boostCool = 0;
            mode = DRIVE;
            car.braking = false;
            return settle(dt) || planPending || needReplan;
        }

        const prevV = car.v;
        // While sliding the tyres have little grip: acceleration is cut, and the
        // sideways scrub bleeds off speed, so the car drags through the corner.
        const sliding = Math.min(1, Math.abs(car.beta) / BETA_MAX);

        // Fire a boost when the pointer is far, the car is lined up with its route,
        // and nothing ahead (a corner or the goal) needs it to slow down soon.
        if (boostT > 0) boostT -= dt;
        if (boostCool > 0) boostCool -= dt;
        if (boostCool <= 0 && tRemaining > BOOST_MIN_DIST && tVLim > V_MAX + 150 && Math.abs(tAlpha) < 0.35 && sliding < 0.2) {
            boostT = BOOST_TIME;
            boostCool = BOOST_TIME + BOOST_COOLDOWN;
            stats.boosts++;
        }
        const boosting = boostT > 0;

        // Pointer close behind and the car nearly stopped: a forward arc can't reach a
        // point inside its own turning circle, so back up and swing round instead.
        if (mode === DRIVE && now > threePointBlockedUntil && car.v < V_CREEP + 10
            && tRemaining < THREE_POINT_DIST
            && (Math.abs(tAlpha) > THREE_POINT_ANGLE || insideTurningCircle(px[pathN - 1], py[pathN - 1]))) {
            car.v = 0;
            reverseT = THREE_POINT_TIME;
            threePoint = true;
            stats.threePoints++;
            return true;
        }

        // Steering is limited to the tightest turning circle. Pure pursuit asks for
        // almost no steering when the target is directly behind, so past 90° use full lock.
        const kappa = Math.abs(tAlpha) > Math.PI / 2
            ? Math.sign(tAlpha) / R_MIN
            : clamp(tKappa, -1 / R_MIN, 1 / R_MIN);

        if (mode === DRIVE && car.v >= OVERSHOOT_MIN_V && sliding < 0.2) maybeLateBrake();

        if (mode === LATE_BRAKING) {
            car.v = Math.max(0, car.v - lateBrake * dt);
            car.braking = true;
            if (car.v < 150) mode = DRIVE;   // too slow by now to make a show of it
        } else {
            // Turning hard (or the pointer is behind): keep creeping forward so the
            // car can turn at all, since steering only works while moving.
            let vFree = Math.max(tVLim * Math.max(0, Math.cos(tAlpha)), Math.min(V_CREEP, tVLim));
            if (Math.abs(kappa) > 1e-4) vFree = Math.min(vFree, Math.sqrt(A_LAT / Math.abs(kappa)));
            const vDes = Math.min(vFree, boosting ? V_BOOST : V_MAX);
            const accel = A_ACCEL * (boosting ? BOOST_ACCEL : 1) * (1 - DRIFT_TRACTION * sliding);
            // When only the top-speed cap is slowing the car (just after a boost), ease off instead of braking.
            const coasting = vFree >= car.v;
            car.v = Math.max(0, car.v + clamp(vDes - car.v, -(coasting ? COAST_DECEL : A_BRAKE) * dt, accel * dt));
            car.braking = !coasting && car.v < prevV - 0.3 * A_BRAKE * dt;
        }

        const nitroWant = boosting ? 1 : 0;
        car.nitro += (nitroWant - car.nitro) * Math.min(1, dt * (nitroWant > car.nitro ? 12 : 6));

        car.v = Math.max(0, car.v - DRIFT_SCRUB * sliding * dt);

        let omega = car.v * kappa;
        if (tRemaining < 8) omega *= tRemaining / 8;
        omega = clamp(omega, -OMEGA_MAX, OMEGA_MAX);

        // Swing the body into the turn in proportion to lateral acceleration; it
        // kicks out quickly and straightens up more slowly.
        const drift = clamp((Math.abs(car.v * omega) - DRIFT_START) / (DRIFT_FULL - DRIFT_START), 0, 1);
        const ts = now / 1000;
        const depth = BETA_MAX * (1 - DRIFT_VARIETY * (0.5 + 0.5 * noise1(ts * 0.4 + 50)));
        const wobble = DRIFT_WOBBLE * noise1(ts * DRIFT_WOBBLE_HZ);
        const betaWant = drift * (Math.sign(omega) * depth + wobble);
        const rate = Math.abs(betaWant) > Math.abs(car.beta) ? 7 : 2.5;
        const nb = car.beta + (betaWant - car.beta) * Math.min(1, dt * rate);

        // Momentum carries the car wide, away from the centre of the turn.
        const slide = -Math.sign(car.beta) * DRIFT_SLIDE * car.v * sliding;

        if (!moveCar(car.v, omega, dt, nb, slide) && car.v > 0) {
            car.v = 0;
            reverseT = REVERSE_TIME;
            threePoint = false;
            stats.bumps++;
        }
        steerVisual(omega, car.v, dt);
        emitMarks(now);
        emitSparks(now, dt);
        if (Math.abs(car.beta) > stats.betaMax) stats.betaMax = Math.abs(car.beta);
        if (car.nitro > stats.nitroMax) stats.nitroMax = car.nitro;
        if (car.v > stats.vMax) stats.vMax = car.v;
        return true;
    }

    // On the final straight, where normal braking would begin, decide whether to
    // brake late instead: only if the line through the pointer and on past it for
    // the whole skid is clear of obstacles.
    function maybeLateBrake() {
        if (!exactGoal || seg < pathN - 2 || Math.abs(tAlpha) > 0.2) return;
        if (tRemaining > (car.v * car.v) / (2 * A_BRAKE) + 30) return;
        const ex = px[pathN - 1];
        const ey = py[pathN - 1];
        if (Math.hypot(ex - car.x, ey - car.y) < 1 || !lineOfSight(car.x, car.y, ex, ey)) return;
        const heading = Math.atan2(ey - car.y, ex - car.x);
        for (let k = 0; k < SKID_TRIES; k++) {
            const lb = rand(LATE_BRAKE_MIN, LATE_BRAKE_MAX);
            const vAtGoal = Math.sqrt(Math.max(0, car.v * car.v - 2 * lb * tRemaining));
            if (vAtGoal < 150) continue;
            const decel = rand(SKID_DECEL_MIN, SKID_DECEL_MAX);
            const curv = k === SKID_TRIES - 1 ? 0 : 1 / rand(SKID_RADIUS_MIN, SKID_RADIUS_MAX);
            const dir = Math.random() < 0.5 ? -1 : 1;
            if (!skidIsClear(ex, ey, heading, vAtGoal, decel, curv, dir)) continue;
            lateBrake = lb;
            skidDecel = decel;
            skidCurv = curv;
            spinDir = dir;
            mode = LATE_BRAKING;
            hotPlans = stats.plans;
            stats.overshoots++;
            return;
        }
    }

    // Simulates a skid starting at (x, y) and checks that the whole slide, plus a
    // margin beyond where it stops, stays in clear space on the planning grid.
    function skidIsClear(x, y, heading, v, decel, curv, dir) {
        const step = 1 / 60;
        let lastX = x;
        let lastY = y;
        while (v > 30) {
            v -= decel * step;
            heading += dir * v * curv * step;
            x += v * Math.cos(heading) * step;
            y += v * Math.sin(heading) * step;
            if (Math.hypot(x - lastX, y - lastY) >= 15) {
                if (!lineOfSight(lastX, lastY, x, y)) return false;
                lastX = x;
                lastY = y;
            }
        }
        return lineOfSight(lastX, lastY, x + Math.cos(heading) * SKID_MARGIN, y + Math.sin(heading) * SKID_MARGIN);
    }

    function startSkid() {
        mode = SKIDDING;
        stats.skids++;
    }

    // Sliding past the pointer: momentum carries the car on along its arc while
    // friction scrubs off speed and the body swings round to face the pointer.
    function skid(dt, now) {
        car.nitro = 0;
        boostT = 0;
        car.braking = true;
        car.v = Math.max(0, car.v - skidDecel * dt);

        const nth = wrap(car.th + spinDir * car.v * skidCurv * dt);
        let diff = wrap(Math.atan2(target.y - car.y, target.x - car.x) - (nth + car.beta));
        if (diff * spinDir < 0 && Math.abs(diff) > 0.3) diff += spinDir * 2 * Math.PI;
        const nb = car.beta + clamp(diff, -SPIN_RATE * dt, SPIN_RATE * dt);
        const nx = car.x + car.v * Math.cos(nth) * dt;
        const ny = car.y + car.v * Math.sin(nth) * dt;
        if (poseCollides(car.x, car.y, car.th + car.beta) || !poseCollides(nx, ny, nth + nb)) {
            car.x = nx;
            car.y = ny;
            car.th = nth;
            car.beta = nb;
        } else if (!poseCollides(nx, ny, nth + car.beta)) {
            car.x = nx;
            car.y = ny;
            car.th = nth;
        } else {
            car.v = 0;
        }
        car.steer += (spinDir * 0.5 - car.steer) * Math.min(1, dt * 10);
        emitMarks(now);

        if (car.v < 30) {
            // Hand back to normal driving, now travelling the way the body faces.
            car.th = wrap(car.th + car.beta);
            car.beta = 0;
            car.v = 0;
            car.parked = false;
            mode = DRIVE;
            plan(now);
        }
        return true;
    }

    // ---------- Nitro sparks (document coordinates, ring buffer) ----------
    const sparks = new Float64Array(SPARK_CAP * 5);  // x, y, vx, vy, birth time
    let sparkHead = 0;
    let sparkCount = 0;
    let sparkDebt = 0;

    function emitSparks(now, dt) {
        if (car.nitro < 0.3) {
            sparkDebt = 0;
            return;
        }
        sparkDebt += dt * SPARK_RATE * car.nitro;
        const yaw = car.th + car.beta;
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        const t = now / 1000;
        while (sparkDebt >= 1) {
            sparkDebt -= 1;
            // Just behind one of the two exhausts at (-13, ±3.4) in the body frame.
            const bx = -17 - Math.random() * 6;
            const by = (Math.random() < 0.5 ? -1 : 1) * 3.4;
            const speed = 40 + Math.random() * 60;
            const lateral = (Math.random() - 0.5) * 50;
            const i = sparkHead * 5;
            sparks[i] = car.x + bx * c - by * s;
            sparks[i + 1] = car.y + bx * s + by * c;
            sparks[i + 2] = -c * speed - s * lateral;
            sparks[i + 3] = -s * speed + c * lateral;
            sparks[i + 4] = t;
            sparkHead = (sparkHead + 1) % SPARK_CAP;
            if (sparkCount < SPARK_CAP) sparkCount++;
        }
    }

    // Lets the body straighten out after stopping; true while still moving.
    function settle(dt) {
        prevWheelValid = false;
        if (Math.abs(car.beta) < 0.005) {
            car.beta = 0;
            return false;
        }
        const nb = relaxedBeta(dt);
        if (poseCollides(car.x, car.y, car.th + nb)) return false;
        car.beta = nb;
        return true;
    }

    // ---------- Drawing ----------
    let vw = 0;
    let vh = 0;
    let dpr = 1;
    const box = [0, 0, 0, 0];
    let hasBox = false;

    const MARK_STYLES = Array.from({ length: MARK_BUCKETS }, (_, b) =>
        `rgba(41, 37, 36, ${(((b + 1) / MARK_BUCKETS) * MARK_ALPHA).toFixed(3)})`);

    const SPARK_STYLES = Array.from({ length: SPARK_BUCKETS }, (_, b) =>
        `rgba(251, 146, 60, ${(((b + 1) / SPARK_BUCKETS) * 0.9).toFixed(3)})`);

    const beamGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, BEAM_LEN);
    beamGradient.addColorStop(0, COLORS.beamNear);
    beamGradient.addColorStop(1, COLORS.beamFar);

    // Nitro flames are drawn in a unit space (nozzle at 0, tip at x = -1) and scaled
    // to size, so these gradients are built once.
    const flameOuter = ctx.createLinearGradient(0, 0, -1, 0);
    flameOuter.addColorStop(0, 'rgba(254, 240, 138, 0.95)');
    flameOuter.addColorStop(0.3, 'rgba(251, 146, 60, 0.9)');
    flameOuter.addColorStop(0.7, 'rgba(220, 38, 38, 0.55)');
    flameOuter.addColorStop(1, 'rgba(127, 29, 29, 0)');
    const flameCore = ctx.createLinearGradient(0, 0, -1, 0);
    flameCore.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    flameCore.addColorStop(0.5, 'rgba(254, 249, 195, 0.7)');
    flameCore.addColorStop(1, 'rgba(254, 215, 170, 0)');

    // A flame tongue: narrow at the nozzle, bulging, then tapering to a point.
    function flamePath() {
        ctx.beginPath();
        ctx.moveTo(0, -0.6);
        ctx.bezierCurveTo(-0.25, -1.15, -0.6, -0.8, -1, 0);
        ctx.bezierCurveTo(-0.6, 0.8, -0.25, 1.15, 0, 0.6);
        ctx.closePath();
    }

    // Each exhaust: two shorter side tongues behind a main tongue with a white-hot
    // core. Every tongue flickers in length and sways on its own noise stream.
    const TONGUE_ANGLE = [-0.16, 0.16, 0];
    const TONGUE_LENGTH = [0.62, 0.58, 1];
    const TONGUE_WIDTH = [0.7, 0.7, 1];

    function drawFlames(t) {
        ctx.globalAlpha = Math.min(1, car.nitro * 1.5);
        const length = 8 + 18 * car.nitro;
        const width = 2.2 + 0.8 * car.nitro;
        for (let side = -1; side <= 1; side += 2) {
            for (let k = 0; k < TONGUE_ANGLE.length; k++) {
                const seed = side * 13 + k * 7;
                const len = length * TONGUE_LENGTH[k] * (0.7 + 0.3 * noise1(t * 30 + seed));
                ctx.save();
                ctx.translate(-12.5, side * 3.4);
                ctx.rotate(TONGUE_ANGLE[k] + 0.08 * noise1(t * 22 + seed + 100));
                ctx.scale(len, width * TONGUE_WIDTH[k]);
                ctx.fillStyle = flameOuter;
                flamePath();
                ctx.fill();
                if (TONGUE_ANGLE[k] === 0) {
                    ctx.scale(0.55, 0.55);
                    ctx.fillStyle = flameCore;
                    flamePath();
                    ctx.fill();
                }
                ctx.restore();
            }
        }
        ctx.globalAlpha = 1;
    }

    function sizeCanvas() {
        vw = document.documentElement.clientWidth;
        vh = window.innerHeight;
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(vw * dpr);
        canvas.height = Math.round(vh * dpr);
        canvas.style.width = `${vw}px`;
        canvas.style.height = `${vh}px`;
        hasBox = false;
    }

    function roundRect(x, y, w, h, r) {
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function drawCar(x, y, yaw, t) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(yaw);

        ctx.fillStyle = beamGradient;
        for (let side = -1; side <= 1; side += 2) {
            ctx.save();
            ctx.translate(12.5, side * 3.75);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, BEAM_LEN, -BEAM_HALF, BEAM_HALF);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }

        if (car.nitro > 0.02) drawFlames(t);

        ctx.fillStyle = COLORS.shadow;
        ctx.beginPath();
        roundRect(-12, -5, 26, 13, 4);
        ctx.fill();

        ctx.fillStyle = COLORS.wheel;
        ctx.fillRect(-10, -7.5, 6, 3);
        ctx.fillRect(-10, 4.5, 6, 3);
        for (let side = -1; side <= 1; side += 2) {
            ctx.save();
            ctx.translate(7, side * 6);
            ctx.rotate(car.steer);
            ctx.fillRect(-3, -1.5, 6, 3);
            ctx.restore();
        }

        ctx.fillStyle = COLORS.body;
        ctx.beginPath();
        roundRect(-13, -6, 26, 12, 4);
        ctx.fill();

        ctx.fillStyle = COLORS.glass;
        ctx.beginPath();
        roundRect(1, -4.5, 5, 9, 1.5);
        ctx.fill();
        ctx.fillStyle = COLORS.glassRear;
        ctx.beginPath();
        roundRect(-9, -4, 3.5, 8, 1.2);
        ctx.fill();
        ctx.fillStyle = COLORS.roof;
        ctx.beginPath();
        roundRect(-5, -4, 6, 8, 1.5);
        ctx.fill();

        ctx.fillStyle = COLORS.head;
        ctx.fillRect(11.5, -5, 1.5, 2.5);
        ctx.fillRect(11.5, 2.5, 1.5, 2.5);
        ctx.fillStyle = car.braking ? COLORS.brake : COLORS.tail;
        ctx.fillRect(-13, -5, 1.5, 2.5);
        ctx.fillRect(-13, 2.5, 1.5, 2.5);

        ctx.restore();
    }

    // Viewport bounds of everything drawn this frame, so next frame clears only that.
    let dx0 = Infinity;
    let dy0 = Infinity;
    let dx1 = -Infinity;
    let dy1 = -Infinity;
    function extend(x0, y0, x1, y1) {
        if (x0 < dx0) dx0 = x0;
        if (y0 < dy0) dy0 = y0;
        if (x1 > dx1) dx1 = x1;
        if (y1 > dy1) dy1 = y1;
    }

    // Draws fading skid marks, batched by opacity level.
    function drawMarks(now, sx, sy) {
        const t = now / 1000;
        while (markCount && t - marks[((markHead - markCount + MARK_CAP) % MARK_CAP) * 6 + 4] > MARK_LIFE) markCount--;
        if (!markCount) return;

        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        for (let b = 0; b < MARK_BUCKETS; b++) {
            let any = false;
            ctx.beginPath();
            for (let k = 0; k < markCount; k++) {
                const i = ((markHead - markCount + k + MARK_CAP) % MARK_CAP) * 6;
                const fade = marks[i + 5] * (1 - (t - marks[i + 4]) / MARK_LIFE);
                if (fade <= 0 || Math.min(MARK_BUCKETS - 1, Math.floor(fade * MARK_BUCKETS)) !== b) continue;
                const ax = marks[i] - sx;
                const ay = marks[i + 1] - sy;
                const bx = marks[i + 2] - sx;
                const by = marks[i + 3] - sy;
                ctx.moveTo(ax, ay);
                ctx.lineTo(bx, by);
                extend(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
                any = true;
            }
            if (any) {
                ctx.strokeStyle = MARK_STYLES[b];
                ctx.stroke();
            }
        }
    }

    // Draws nitro sparks drifting back from the exhausts, batched by opacity level.
    function drawSparks(now, sx, sy) {
        const t = now / 1000;
        while (sparkCount && t - sparks[((sparkHead - sparkCount + SPARK_CAP) % SPARK_CAP) * 5 + 4] > SPARK_LIFE) sparkCount--;
        if (!sparkCount) return;

        for (let b = 0; b < SPARK_BUCKETS; b++) {
            let any = false;
            ctx.beginPath();
            for (let k = 0; k < sparkCount; k++) {
                const i = ((sparkHead - sparkCount + k + SPARK_CAP) % SPARK_CAP) * 5;
                const age = t - sparks[i + 4];
                const life = 1 - age / SPARK_LIFE;
                if (life <= 0 || Math.min(SPARK_BUCKETS - 1, Math.floor(life * SPARK_BUCKETS)) !== b) continue;
                const x = sparks[i] + sparks[i + 2] * age - sx;
                const y = sparks[i + 1] + sparks[i + 3] * age - sy;
                const r = 0.6 + 0.9 * life;
                ctx.moveTo(x + r, y);
                ctx.arc(x, y, r, 0, 2 * Math.PI);
                extend(x - r, y - r, x + r, y + r);
                any = true;
            }
            if (any) {
                ctx.fillStyle = SPARK_STYLES[b];
                ctx.fill();
            }
        }
    }

    function draw(now) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (hasBox) ctx.clearRect(box[0], box[1], box[2], box[3]);
        hasBox = false;
        dx0 = Infinity;
        dy0 = Infinity;
        dx1 = -Infinity;
        dy1 = -Infinity;

        const sx = window.scrollX;
        const sy = window.scrollY;
        drawMarks(now, sx, sy);
        drawSparks(now, sx, sy);

        const vx = car.x - sx;
        const vy = car.y - sy;
        const reach = NOSE + BEAM_LEN + 4;
        if (vx >= -reach && vy >= -reach && vx <= vw + reach && vy <= vh + reach) {
            drawCar(vx, vy, car.th + car.beta, now / 1000);
            extend(vx - reach, vy - reach, vx + reach, vy + reach);
        }

        if (dx0 > dx1) return;
        box[0] = dx0 - 3;
        box[1] = dy0 - 3;
        box[2] = dx1 - dx0 + 6;
        box[3] = dy1 - dy0 + 6;
        hasBox = true;
    }

    // ---------- Loop and events ----------
    let rafId = 0;
    let lastTs = 0;
    let rebuildTimer = 0;

    function frame(ts) {
        rafId = 0;
        const t0 = performance.now();
        const dt = lastTs ? Math.min((ts - lastTs) / 1000, 1 / 30) : 1 / 60;
        lastTs = ts;
        const active = update(dt, ts);
        draw(ts);
        const ms = performance.now() - t0;
        stats.frames++;
        stats.frameMsTotal += ms;
        if (ms > stats.frameMsMax) stats.frameMsMax = ms;
        if (markCount > stats.marks) stats.marks = markCount;
        // Keep animating while skid marks or sparks are still fading out.
        if (active || markCount || sparkCount) wake();
        else lastTs = 0;
    }

    function wake() {
        if (!rafId) rafId = requestAnimationFrame(frame);
    }

    function placeAtFree(x, y) {
        const c = nearestFree(x, y, 200);
        car.x = c >= 0 ? cellCx(c) : x;
        car.y = c >= 0 ? cellCy(c) : y;
        car.v = 0;
        car.parked = true;
        target.x = car.x;
        target.y = car.y;
        needReplan = true;
    }

    function scheduleRebuild() {
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => {
            rebuild();
            // Until the visitor moves the mouse, quietly relocate if content landed on the car.
            if (!pointer.seen && (blocked[cellOf(car.x, car.y)] || poseCollides(car.x, car.y, car.th + car.beta))) {
                placeAtFree(car.x, car.y);
            }
            wake();
        }, 120);
    }

    window.addEventListener('mousemove', (e) => {
        pointer.x = e.clientX;
        pointer.y = e.clientY;
        pointer.seen = true;
        wake();
    }, { passive: true });
    window.addEventListener('scroll', wake, { passive: true });
    document.addEventListener('scroll', (e) => {
        if (e.target !== document) scheduleRebuild();
    }, { capture: true, passive: true });
    window.addEventListener('resize', () => {
        sizeCanvas();
        scheduleRebuild();
        wake();
    });
    window.addEventListener('load', scheduleRebuild);
    document.addEventListener('load', (e) => {
        if (e.target.tagName === 'IMG' && !e.target.closest('.bg-image')) scheduleRebuild();
    }, true);
    new MutationObserver(scheduleRebuild).observe(document.body, { childList: true, subtree: true, characterData: true });
    new ResizeObserver(scheduleRebuild).observe(document.body);
    if (document.fonts) document.fonts.ready.then(scheduleRebuild);

    sizeCanvas();
    rebuild();
    placeAtFree(Math.min(48, worldW * 0.04), window.scrollY + window.innerHeight * 0.6);
    wake();

    if (window.__CAR_DEBUG__) {
        window.__car = {
            car, target, stats, poseCollides,
            rects: () => rects.subarray(0, rectCount * 4),
            path: () => Array.from({ length: pathN }, (_, k) => [px[k], py[k]]),
            isLooping: () => rafId !== 0,
            overshoot: () => ({ mode, lateBrake, skidDecel, radius: skidCurv ? 1 / skidCurv : Infinity, spinDir }),
        };
    }
})();
