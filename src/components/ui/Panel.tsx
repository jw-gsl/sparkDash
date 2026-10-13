import type { ReactNode, CSSProperties } from "react";
import { ChevronDownIcon } from "./icons";
import { usePanelDragHandle } from "./panelDrag";
import { togglePanel, usePanelCollapsed } from "./panelCollapse";

interface PanelProps {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  accent?: boolean;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
  /** Tooltip on the title, for readings that are easy to misread. */
  hint?: string;
  /** Remembers collapsed state; defaults to the title. Set when two panels share a title. */
  collapseKey?: string;
  children: ReactNode;
}

/**
 * Shared panel primitive. Flat surface with a thin neutral border and a
 * consistent title row: small muted icon, sentence-case title, and optional
 * actions on the right (wrapping under the title on narrow screens). `accent`
 * is kept for API compatibility; the redesign no longer draws the left tick.
 */
export function Panel({
  title,
  icon,
  actions,
  accent = false,
  className = "",
  bodyClassName = "",
  style,
  hint,
  collapseKey,
  children,
}: PanelProps) {
  const key = collapseKey ?? title;
  const collapsed = usePanelCollapsed(key);
  const drag = usePanelDragHandle();
  return (
    <section
      className={`panel ${accent ? "panel-accent" : ""} ${className}`}
      style={{ padding: "var(--density-panel-pad)", ...style }}
    >
      <header
        className="panel-head flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
        style={{ marginBottom: collapsed ? 0 : "var(--density-panel-title-mb)" }}
      >
        <h3 className="panel-title flex min-w-0 items-center gap-2" title={hint}>
          {icon}
          {title}
        </h3>
        <div className="panel-actions flex min-w-0 flex-wrap items-center gap-1.5">
          {actions}
          {drag && (
            <button
              type="button"
              ref={drag.setActivatorNodeRef}
              {...drag.attributes}
              {...drag.listeners}
              className="btn btn--sm btn--ghost panel-grip"
              aria-label={`Drag to reorder ${title}`}
              title="Drag to reorder"
              style={{ cursor: "grab", touchAction: "none" }}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
                <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
                <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm btn--ghost panel-collapse"
            onClick={() => togglePanel(key)}
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${title}`}
            title={collapsed ? "Expand" : "Collapse"}
          >
            <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
          </button>
        </div>
      </header>
      <div className={bodyClassName} style={collapsed ? { display: "none" } : undefined}>
        {children}
      </div>
    </section>
  );
}