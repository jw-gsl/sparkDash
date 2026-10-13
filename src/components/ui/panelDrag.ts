import { createContext, useContext } from "react";
import type { DraggableAttributes } from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";

/** Drag handle wiring a sortable block hands down to its <Panel> header. */
export interface PanelDragHandle {
  attributes: DraggableAttributes;
  listeners: SyntheticListenerMap | undefined;
  setActivatorNodeRef: (el: HTMLElement | null) => void;
}

export const PanelDragContext = createContext<PanelDragHandle | null>(null);
export const usePanelDragHandle = () => useContext(PanelDragContext);
