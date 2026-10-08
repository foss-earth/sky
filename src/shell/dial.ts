/**
 * A dial: a circular slider for a quantity that comes round again, such as
 * the time of day or the day of the year. Its track is a ring the caller
 * colours with arcs; its knob is the value. Dragging the knob past the top of
 * the cycle carries on into the next, as a clock's hand does, so the caller is
 * told how far the drag has turned in all, full turns included. Named moments
 * sit on the ring as marks, their labels written round the edge, each a press
 * away; the caller's readout and buttons sit in the middle.
 *
 * Places on the dial are turns clockwise from the top: 0 is the top, 0.25 the
 * right, 0.5 the bottom.
 */

export interface DialMark {
  id: string;
  /** The word written by the edge. */
  label: string;
  turn: number;
  /** Its accessible name, which also shows on hover: what the moment is, and when. */
  title: string;
}

/** A stretch of the track in one colour, clockwise from `from` to `to`; a whole turn or more colours the ring. */
export interface DialArc {
  from: number;
  to: number;
  colour: string;
}

export interface DialTick {
  turn: number;
  major?: boolean;
}

export interface DialFrame {
  /** Where the knob is. */
  turn: number;
  /** The knob's value as a step of the cycle, from 0, and as words. */
  valueNow: number;
  valueText: string;
  arcs: readonly DialArc[];
  ticks: readonly DialTick[];
  marks: readonly DialMark[];
  /** A hollow ring on the track, such as where the clock is while another time is set. */
  ring?: { turn: number; title: string } | null;
  disabled?: boolean;
}

export type DialKey = "next" | "previous" | "pageNext" | "pagePrevious" | "start" | "end";

export interface DialOptions {
  ariaLabel: string;
  /** The knob's last step for assistive technology: steps run from 0 to this. */
  valueMax: number;
  /** Shown in the middle: the caller's readout and buttons. */
  centre: HTMLElement;
  /** A press on the track away from the knob, which takes the knob there within the cycle shown. */
  onPress(turn: number): void;
  /** A drag starts, after any press. */
  onDragStart(): void;
  /** The drag has turned this far since it started, in turns, clockwise positive, full turns included. */
  onDrag(travel: number): void;
  onDragEnd?(): void;
  /** A key on the knob: a step or a page either way, or the cycle's start or end. */
  onKey(key: DialKey): void;
  onMark(id: string): void;
}

export interface DialHandle {
  element: HTMLElement;
  render(frame: DialFrame): void;
  /** True while a drag holds the knob. */
  isDragging(): boolean;
  destroy(): void;
}

/** The dial's shape, in px of its own size: the track, ticks inside it, marks' ticks outside it, and the labels' line round the edge. */
const DIAL = {
  size: 140,
  trackRadius: 46,
  trackWidth: 10,
  knobRadius: 7,
  tickOuter: 39.5,
  tickInner: 37,
  majorTickInner: 34,
  markTickLength: 5,
  labelRadius: 61,
  /** A label's advance for each character at the labels' size, and the room kept either side of it, px. */
  labelCharPx: 5.3,
  labelGapPx: 6,
  labelHitWidth: 18,
  ringRadius: 3.5,
  /** How far inside and outside the track a press still takes the knob. */
  pressSlackPx: 9,
  /** Passes that push overlapping labels apart; a few settle the handful a dial has. */
  labelPasses: 12,
} as const;

/** Labels whose middle is this far round from the top or more, and as far from the bottom, are written along the bottom of the ring, upright. */
const LOWER_LABELS = { from: 0.3, to: 0.7 } as const;

const SVG_NS = "http://www.w3.org/2000/svg";
const KEYS: Readonly<Record<string, DialKey>> = {
  ArrowRight: "next",
  ArrowUp: "next",
  ArrowLeft: "previous",
  ArrowDown: "previous",
  PageUp: "pageNext",
  PageDown: "pagePrevious",
  Home: "start",
  End: "end",
};

let dialCount = 0;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

/** A turn's fraction, from 0 up to 1. */
export function wrapTurn(turn: number): number {
  return turn - Math.floor(turn);
}

const centre = DIAL.size / 2;
const at = (turn: number, radius: number): [number, number] => [
  centre + radius * Math.sin(turn * 2 * Math.PI),
  centre - radius * Math.cos(turn * 2 * Math.PI),
];
const round = (value: number): string => String(Math.round(value * 100) / 100);

/** An arc clockwise from one turn to another; a whole turn or more draws the circle. */
function arcPath(from: number, to: number, radius: number): string {
  const span = to - from;
  if (span >= 1) {
    const [x, y] = at(0, radius);
    const [bx, by] = at(0.5, radius);
    return `M${round(x)},${round(y)}A${radius},${radius} 0 1 1 ${round(bx)},${round(by)}A${radius},${radius} 0 1 1 ${round(x)},${round(y)}`;
  }
  const [x0, y0] = at(from, radius);
  const [x1, y1] = at(to, radius);
  return `M${round(x0)},${round(y0)}A${radius},${radius} 0 ${span > 0.5 ? 1 : 0} 1 ${round(x1)},${round(y1)}`;
}

interface PlacedLabel {
  mark: DialMark;
  /** Where the label's middle sits, and half its length, in turns. */
  middle: number;
  half: number;
}

/**
 * Each label as near its mark as the others allow: neighbours that would
 * overlap are pushed apart equally until none do.
 */
export function placeLabels(marks: readonly DialMark[]): PlacedLabel[] {
  const circumference = 2 * Math.PI * DIAL.labelRadius;
  const placed = marks
    .map(mark => ({ mark, middle: wrapTurn(mark.turn), half: (mark.label.length * DIAL.labelCharPx + DIAL.labelGapPx) / circumference / 2 }))
    .sort((a, b) => a.middle - b.middle);
  if (placed.length < 2) return placed;
  for (let pass = 0; pass < DIAL.labelPasses; pass++) {
    let moved = false;
    for (let index = 0; index < placed.length; index++) {
      const a = placed[index];
      const b = placed[(index + 1) % placed.length];
      const overlap = a.half + b.half - wrapTurn(b.middle - a.middle);
      if (overlap <= 0) continue;
      a.middle -= overlap / 2;
      b.middle += overlap / 2;
      moved = true;
    }
    if (!moved) break;
  }
  return placed;
}

/** A circle for labels to be written along: clockwise from the bottom, or anticlockwise from the top. */
function labelLine(id: string, clockwise: boolean): SVGPathElement {
  const r = DIAL.labelRadius;
  const [tx, ty] = at(0, r);
  const [bx, by] = at(0.5, r);
  const d = clockwise
    ? `M${bx},${by}A${r},${r} 0 1 1 ${tx},${ty}A${r},${r} 0 1 1 ${bx},${by}`
    : `M${tx},${ty}A${r},${r} 0 1 0 ${bx},${by}A${r},${r} 0 1 0 ${tx},${ty}`;
  return svg("path", { id, d, fill: "none" });
}

interface MarkElements {
  group: SVGGElement;
  title: SVGTitleElement;
  hit: SVGPathElement;
  tick: SVGLineElement;
  text: SVGTextElement;
  textPath: SVGTextPathElement;
}

export function createDial(options: DialOptions): DialHandle {
  const id = `foss-earth-dial-${++dialCount}`;
  const element = document.createElement("div");
  element.className = "foss-earth-dial";
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", options.ariaLabel);
  const face = svg("svg", { class: "foss-earth-dial__face", viewBox: `0 0 ${DIAL.size} ${DIAL.size}`, width: DIAL.size, height: DIAL.size });
  const defs = svg("defs");
  const upper = labelLine(`${id}-upper`, true);
  const lower = labelLine(`${id}-lower`, false);
  defs.append(upper, lower);
  // A faint edge either side of the track, so a dark night still reads as part of the ring on a dark panel.
  const edge = svg("circle", { class: "foss-earth-dial__edge", cx: centre, cy: centre, r: DIAL.trackRadius, fill: "none", "stroke-width": DIAL.trackWidth + 2 });
  const arcs = svg("g", { class: "foss-earth-dial__arcs" });
  const ticks = svg("g", { class: "foss-earth-dial__ticks" });
  const marks = svg("g", { class: "foss-earth-dial__marks" });
  const ring = svg("circle", { class: "foss-earth-dial__ring", r: DIAL.ringRadius });
  const ringTitle = svg("title");
  ring.append(ringTitle);
  const knob = svg("circle", { class: "foss-earth-dial__knob", r: DIAL.knobRadius, role: "slider", tabindex: 0 });
  knob.setAttribute("aria-label", options.ariaLabel);
  knob.setAttribute("aria-valuemin", "0");
  knob.setAttribute("aria-valuemax", String(options.valueMax));
  face.append(defs, edge, arcs, ticks, marks, ring, knob);
  const middle = document.createElement("div");
  middle.className = "foss-earth-dial__centre";
  middle.append(options.centre);
  element.append(face, middle);

  const markElements = new Map<string, MarkElements>();
  let arcsKey = "";
  let ticksKey = "";
  let disabled = false;
  let drag: { pointerId: number; lastTurn: number; travel: number } | null = null;

  /** Where a pointer is on the dial: its turn and its distance from the middle, in the dial's own px. */
  const locate = (event: PointerEvent): { turn: number; distance: number } => {
    const box = face.getBoundingClientRect();
    const scale = box.width > 0 ? box.width / DIAL.size : 1;
    const dx = (event.clientX - box.left) / scale - centre;
    const dy = (event.clientY - box.top) / scale - centre;
    return { turn: wrapTurn(Math.atan2(dx, -dy) / (2 * Math.PI)), distance: Math.hypot(dx, dy) };
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (disabled || event.button !== 0 || drag) return;
    const target = event.target as Element | null;
    if (target?.closest?.("[data-mark]")) return;
    const { turn, distance } = locate(event);
    const onKnob = target === knob;
    const reach = DIAL.trackWidth / 2 + DIAL.pressSlackPx;
    if (!onKnob && Math.abs(distance - DIAL.trackRadius) > reach) return;
    event.preventDefault();
    try { face.setPointerCapture(event.pointerId); } catch { /* the pointer may already be gone */ }
    knob.focus({ preventScroll: true });
    if (!onKnob) options.onPress(turn);
    drag = { pointerId: event.pointerId, lastTurn: turn, travel: 0 };
    options.onDragStart();
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const { turn } = locate(event);
    // The shorter way round from where it was: a drag never jumps half a turn between two events.
    drag.travel += wrapTurn(turn - drag.lastTurn + 0.5) - 0.5;
    drag.lastTurn = turn;
    options.onDrag(drag.travel);
  };
  const onPointerEnd = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    try { face.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    options.onDragEnd?.();
  };
  const onKnobKey = (event: KeyboardEvent): void => {
    const key = KEYS[event.key];
    if (!key || disabled) return;
    event.preventDefault();
    options.onKey(key);
  };
  const markOf = (event: Event): string | null => {
    const group = (event.target as Element | null)?.closest?.("[data-mark]");
    return group && group.getAttribute("aria-disabled") !== "true" ? group.getAttribute("data-mark") : null;
  };
  const onMarkClick = (event: MouseEvent): void => {
    const mark = markOf(event);
    if (mark !== null) options.onMark(mark);
  };
  const onMarkKey = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const mark = markOf(event);
    if (mark === null) return;
    event.preventDefault();
    options.onMark(mark);
  };
  face.addEventListener("pointerdown", onPointerDown);
  face.addEventListener("pointermove", onPointerMove);
  face.addEventListener("pointerup", onPointerEnd);
  face.addEventListener("pointercancel", onPointerEnd);
  knob.addEventListener("keydown", onKnobKey);
  marks.addEventListener("click", onMarkClick);
  marks.addEventListener("keydown", onMarkKey);

  function markElementsFor(mark: DialMark): MarkElements {
    let elements = markElements.get(mark.id);
    if (!elements) {
      const group = svg("g", { class: "foss-earth-dial__mark", role: "button", tabindex: 0, "data-mark": mark.id });
      const title = svg("title");
      const hit = svg("path", { class: "foss-earth-dial__mark-hit", "stroke-width": DIAL.labelHitWidth });
      const tick = svg("line", { class: "foss-earth-dial__mark-tick" });
      const text = svg("text", { class: "foss-earth-dial__label", "dominant-baseline": "central" });
      const textPath = svg("textPath", { "text-anchor": "middle" });
      text.append(textPath);
      group.append(title, hit, tick, text);
      marks.append(group);
      elements = { group, title, hit, tick, text, textPath };
      markElements.set(mark.id, elements);
    }
    return elements;
  }

  return {
    element,
    isDragging: () => drag !== null,
    render(frame) {
      disabled = Boolean(frame.disabled);
      element.classList.toggle("is-disabled", disabled);
      const nextArcs = frame.arcs.map(arc => `${arc.from}:${arc.to}:${arc.colour}`).join("|");
      if (nextArcs !== arcsKey) {
        arcsKey = nextArcs;
        arcs.replaceChildren(...frame.arcs.map(arc => svg("path", {
          d: arcPath(arc.from, arc.to, DIAL.trackRadius), stroke: arc.colour, "stroke-width": DIAL.trackWidth, fill: "none",
        })));
      }
      const nextTicks = frame.ticks.map(tick => `${tick.turn}:${tick.major ? 1 : 0}`).join("|");
      if (nextTicks !== ticksKey) {
        ticksKey = nextTicks;
        ticks.replaceChildren(...frame.ticks.map(tick => {
          const [x0, y0] = at(tick.turn, tick.major ? DIAL.majorTickInner : DIAL.tickInner);
          const [x1, y1] = at(tick.turn, DIAL.tickOuter);
          return svg("line", { class: `foss-earth-dial__tick${tick.major ? " is-major" : ""}`, x1: round(x0), y1: round(y0), x2: round(x1), y2: round(y1) });
        }));
      }

      const seen = new Set<string>();
      const outer = DIAL.trackRadius + DIAL.trackWidth / 2;
      for (const { mark, middle, half } of placeLabels(frame.marks)) {
        seen.add(mark.id);
        const elements = markElementsFor(mark);
        elements.group.setAttribute("aria-label", mark.title);
        elements.group.setAttribute("aria-disabled", String(disabled));
        elements.group.setAttribute("tabindex", disabled ? "-1" : "0");
        if (elements.title.textContent !== mark.title) elements.title.textContent = mark.title;
        const [x0, y0] = at(mark.turn, outer);
        const [x1, y1] = at(mark.turn, outer + DIAL.markTickLength);
        elements.tick.setAttribute("x1", round(x0));
        elements.tick.setAttribute("y1", round(y0));
        elements.tick.setAttribute("x2", round(x1));
        elements.tick.setAttribute("y2", round(y1));
        elements.hit.setAttribute("d", arcPath(middle - half, middle + half, DIAL.labelRadius));
        // Upright either way: along the top clockwise, along the bottom anticlockwise.
        const along = wrapTurn(middle);
        const isLower = along > LOWER_LABELS.from && along < LOWER_LABELS.to;
        const circumference = 2 * Math.PI * DIAL.labelRadius;
        const offset = isLower ? wrapTurn(-along) * circumference : wrapTurn(along - 0.5) * circumference;
        elements.textPath.setAttribute("href", `#${isLower ? lower.id : upper.id}`);
        elements.textPath.setAttribute("startOffset", round(offset));
        if (elements.textPath.textContent !== mark.label) elements.textPath.textContent = mark.label;
      }
      for (const [markId, elements] of markElements) {
        if (!seen.has(markId)) { elements.group.remove(); markElements.delete(markId); }
      }

      ring.style.display = frame.ring ? "" : "none";
      if (frame.ring) {
        const [rx, ry] = at(frame.ring.turn, DIAL.trackRadius);
        ring.setAttribute("cx", round(rx));
        ring.setAttribute("cy", round(ry));
        if (ringTitle.textContent !== frame.ring.title) ringTitle.textContent = frame.ring.title;
      }
      const [kx, ky] = at(frame.turn, DIAL.trackRadius);
      knob.setAttribute("cx", round(kx));
      knob.setAttribute("cy", round(ky));
      knob.setAttribute("aria-valuenow", String(frame.valueNow));
      knob.setAttribute("aria-valuetext", frame.valueText);
      knob.setAttribute("aria-disabled", String(disabled));
      knob.setAttribute("tabindex", disabled ? "-1" : "0");
    },
    destroy() {
      face.removeEventListener("pointerdown", onPointerDown);
      face.removeEventListener("pointermove", onPointerMove);
      face.removeEventListener("pointerup", onPointerEnd);
      face.removeEventListener("pointercancel", onPointerEnd);
      knob.removeEventListener("keydown", onKnobKey);
      marks.removeEventListener("click", onMarkClick);
      marks.removeEventListener("keydown", onMarkKey);
      element.remove();
    },
  };
}
