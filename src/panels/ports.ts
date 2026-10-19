import type { SettingsStorage } from "@foss-earth/ui/settings";
import type { createParameterSection, createSectionsElement, appendHostSections, createHelpTooltip, createIconButton } from "@foss-earth/ui/browser";
/** Temporary structural dial contract; generic implementation stays UI-owned. */
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

export interface SkyPanelUiPorts {
  createParameterSection: typeof createParameterSection;
  createSectionsElement: typeof createSectionsElement;
  appendHostSections: typeof appendHostSections;
  /** The trailing **?** that holds what a line leaves out. */
  createHelpTooltip: typeof createHelpTooltip;
  /** A compact action with a mark and its full name, such as Open Date and time. */
  createIconButton: typeof createIconButton;
}
export interface SkyDateTimeUiPorts extends SkyPanelUiPorts {
  createDial(options: DialOptions): DialHandle;
  wrapTurn(turn: number): number;
}
/** Host supplies visible clock/place refreshes; panels never start a timer. */
export interface SkyPanelRefreshPort { subscribe(listener: () => void): () => void }
export interface SkyPanelStorageOptions { panelStorage?: SettingsStorage | null }
