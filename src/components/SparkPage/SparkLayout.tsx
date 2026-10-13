import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PanelDragContext } from "../ui/panelDrag";
import { saveSparkLayout, useSparkLayout, type SparkLayoutState } from "./sparkLayoutStore";

export interface LayoutBlock {
  id: string;
  /** Column the block sits in until the user moves it. */
  col: "left" | "right";
  /** "wide" fills its row; "small" shares a row with other small blocks. */
  size: "wide" | "small";
  /** Position when the columns stack on narrow screens (before the user reorders). */
  mobileOrder: number;
  node: ReactNode;
}

type Col = "left" | "right";

/** Saved order first (for blocks that still exist), then any new block in its default spot. */
export function reconcileLayout(blocks: LayoutBlock[], saved: SparkLayoutState | null): SparkLayoutState {
  const known = new Set(blocks.map((b) => b.id));
  const placed = new Set<string>();
  const out: SparkLayoutState = { left: [], right: [] };
  for (const col of ["left", "right"] as Col[]) {
    for (const id of saved?.[col] ?? []) {
      if (known.has(id) && !placed.has(id)) {
        out[col].push(id);
        placed.add(id);
      }
    }
  }
  for (const b of blocks) {
    if (!placed.has(b.id)) out[b.col].push(b.id);
  }
  return out;
}

function SortableBlock({ block, mobileOrder }: { block: LayoutBlock; mobileOrder: number }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : undefined,
    zIndex: isDragging ? 20 : undefined,
    position: "relative",
    ["--o" as string]: mobileOrder,
  } as CSSProperties;
  return (
    <div ref={setNodeRef} style={style} className={`sp-item sp-item--${block.size}`}>
      <PanelDragContext.Provider value={{ attributes, listeners, setActivatorNodeRef }}>
        {block.node}
      </PanelDragContext.Provider>
    </div>
  );
}

function Column({
  col,
  ids,
  byId,
  mobileOrder,
  footer,
}: {
  col: Col;
  ids: string[];
  byId: Map<string, LayoutBlock>;
  mobileOrder: Map<string, number>;
  footer?: ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: `col:${col}` });
  return (
    <div className="sp-col" ref={setNodeRef}>
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        {ids.map((id) => {
          const block = byId.get(id);
          return block ? <SortableBlock key={id} block={block} mobileOrder={mobileOrder.get(id) ?? 0} /> : null;
        })}
      </SortableContext>
      {footer}
    </div>
  );
}

/** The Sparks page's two columns, with blocks the user can drag up, down and across. */
export function SparkLayout({ blocks, rightFooter }: { blocks: LayoutBlock[]; rightFooter?: ReactNode }) {
  const saved = useSparkLayout();
  const [draft, setDraft] = useState<SparkLayoutState | null>(null);
  const reconciled = useMemo(() => reconcileLayout(blocks, saved), [blocks, saved]);
  const cols = draft ?? reconciled;
  const byId = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);

  // Narrow screens stack the columns: keep the designed order until the user rearranges.
  const mobileOrder = useMemo(() => {
    const m = new Map<string, number>();
    if (saved) [...cols.left, ...cols.right].forEach((id, i) => m.set(id, i));
    else blocks.forEach((b) => m.set(b.id, b.mobileOrder));
    return m;
  }, [blocks, cols, saved]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const colOf = (state: SparkLayoutState, id: string): Col | null => {
    if (id === "col:left") return "left";
    if (id === "col:right") return "right";
    if (state.left.includes(id)) return "left";
    if (state.right.includes(id)) return "right";
    return null;
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const base = draft ?? reconciled;
    const from = colOf(base, String(active.id));
    const to = colOf(base, String(over.id));
    if (!from || !to || from === to) return;
    const activeId = String(active.id);
    const overIdx = base[to].indexOf(String(over.id));
    const insertAt = overIdx >= 0 ? overIdx : base[to].length;
    setDraft({
      ...base,
      [from]: base[from].filter((id) => id !== activeId),
      [to]: [...base[to].slice(0, insertAt), activeId, ...base[to].slice(insertAt)],
    } as SparkLayoutState);
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    let next = draft ?? reconciled;
    if (over) {
      const col = colOf(next, String(active.id));
      if (col && colOf(next, String(over.id)) === col) {
        const from = next[col].indexOf(String(active.id));
        const to = next[col].indexOf(String(over.id));
        if (from >= 0 && to >= 0 && from !== to) {
          next = { ...next, [col]: arrayMove(next[col], from, to) };
        }
      }
    }
    setDraft(null);
    saveSparkLayout(next);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDraft(null)}
    >
      <div className="sp-cols">
        <Column col="left" ids={cols.left} byId={byId} mobileOrder={mobileOrder} />
        <Column
          col="right"
          ids={cols.right}
          byId={byId}
          mobileOrder={mobileOrder}
          footer={rightFooter ? <div className="sp-item sp-item--wide" style={{ ["--o" as string]: 30 } as CSSProperties}>{rightFooter}</div> : null}
        />
      </div>
    </DndContext>
  );
}
