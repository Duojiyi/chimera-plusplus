import { useCallback, useMemo, useState } from "react";
import type { DragEvent } from "react";

export interface SortableRowProps {
  /** Set on the row so it can be dropped on. */
  rowProps: {
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
  /** Set on the grip that starts the drag. */
  gripProps: {
    draggable: true;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
  };
  dragging: boolean;
  /** Where a drop here would land relative to this row. */
  dropEdge: "before" | "after" | null;
}

/** `ids` with `id` moved to where `target` is. */
export function moveBefore(ids: string[], id: string, target: string) {
  if (id === target) return ids;
  const from = ids.indexOf(id);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0) return ids;
  const next = ids.filter((item) => item !== id);
  const at = next.indexOf(target);
  // Dragging down puts the row after the one it is dropped on, up before it.
  next.splice(from < to ? at + 1 : at, 0, id);
  return next;
}

/** `ids` with `id` moved one place up or down. */
export function moveBy(ids: string[], id: string, delta: -1 | 1) {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/**
 * Drag-to-reorder for a list of rows, with the grip as the only handle (the
 * rest of a row stays selectable). Dependency-free: the browser's own drag
 * and drop. Keyboard reordering is the caller's, through {@link moveBy}.
 */
export function useSortable(
  ids: string[],
  onReorder: (next: string[]) => void,
) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const end = useCallback(() => {
    setDragId(null);
    setOverId(null);
  }, []);

  const bind = useMemo(
    () =>
      (id: string): SortableRowProps => {
        const from = dragId ? ids.indexOf(dragId) : -1;
        const here = ids.indexOf(id);
        return {
          dragging: dragId === id,
          dropEdge:
            dragId && overId === id && dragId !== id
              ? from < here
                ? "after"
                : "before"
              : null,
          gripProps: {
            draggable: true,
            onDragStart: (event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", id);
              const row = event.currentTarget.closest("li");
              if (row) event.dataTransfer.setDragImage(row, 16, 16);
              setDragId(id);
            },
            onDragEnd: end,
          },
          rowProps: {
            onDragOver: (event) => {
              if (!dragId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (overId !== id) setOverId(id);
            },
            onDrop: (event) => {
              if (!dragId) return;
              event.preventDefault();
              const next = moveBefore(ids, dragId, id);
              end();
              if (next.some((item, index) => item !== ids[index]))
                onReorder(next);
            },
          },
        };
      },
    [dragId, overId, ids, onReorder, end],
  );

  return bind;
}
