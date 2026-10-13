import { ChevronDownIcon } from "./icons";
import { resetSparkLayout, useSparkLayout } from "../SparkPage/sparkLayoutStore";
import { collapseAllPanels, expandAllPanels, useCollapsiblePanelCount } from "./panelCollapse";

/** Collapse all / Expand all for the panels on the current page. Hidden when there are none. */
export function PanelCollapseControls({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const count = useCollapsiblePanelCount();
  const customLayout = useSparkLayout() != null;
  if (count === 0) return null;
  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <button type="button" className="btn btn--sm" onClick={collapseAllPanels} title="Collapse all blocks" aria-label="Collapse all blocks">
        <ChevronDownIcon className="h-3.5 w-3.5 -rotate-90" />
        {!compact && <span className="hidden sm:inline">Collapse all</span>}
      </button>
      <button type="button" className="btn btn--sm" onClick={expandAllPanels} title="Expand all blocks" aria-label="Expand all blocks">
        <ChevronDownIcon className="h-3.5 w-3.5" />
        {!compact && <span className="hidden sm:inline">Expand all</span>}
      </button>
      {customLayout && (
        <button type="button" className="btn btn--sm btn--ghost" onClick={resetSparkLayout} title="Put the blocks back in their default order" aria-label="Reset block order">
          {!compact ? "Reset order" : "↺"}
        </button>
      )}
    </div>
  );
}
