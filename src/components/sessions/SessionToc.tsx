import { List, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface TocItem {
  index: number;
  preview: string;
  ts?: number;
}

/** A table of contents helps only once there is something to skip over. */
const MIN_TOC_ITEMS = 3;

interface SessionTocSidebarProps {
  items: TocItem[];
  onItemClick: (index: number) => void;
}

export function SessionTocSidebar({
  items,
  onItemClick,
}: SessionTocSidebarProps) {
  if (items.length < MIN_TOC_ITEMS) return null;

  return (
    <nav
      className="w-64 border-l shrink-0 hidden xl:block"
      aria-label="对话目录"
    >
      <div className="p-3 border-b">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <List className="size-3.5" aria-hidden />
          <span>对话目录</span>
        </div>
      </div>
      <ScrollArea className="h-[calc(100%-40px)]">
        <div className="p-2 space-y-0.5">
          {items.map((item, tocIndex) => (
            <button
              key={item.index}
              type="button"
              onClick={() => onItemClick(item.index)}
              className={cn(
                "w-full text-left px-2 py-1.5 rounded text-xs transition-colors",
                "hover:bg-muted/80 text-muted-foreground hover:text-foreground",
                "flex items-start gap-2",
              )}
            >
              <span className="session-toc-number">{tocIndex + 1}</span>
              <span className="line-clamp-2 leading-snug">{item.preview}</span>
            </button>
          ))}
        </div>
      </ScrollArea>
    </nav>
  );
}

interface SessionTocDialogProps {
  items: TocItem[];
  onItemClick: (index: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Below the width where the sidebar fits, the contents open from a button in
 * the conversation header instead of a floating button over the messages.
 */
export function SessionTocDialog({
  items,
  onItemClick,
  open,
  onOpenChange,
}: SessionTocDialogProps) {
  if (items.length < MIN_TOC_ITEMS) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="session-toc-trigger xl:hidden"
          aria-label={`对话目录（${items.length} 条提问）`}
        >
          <List className="size-3.5" aria-hidden />
          目录
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-w-md max-h-[70vh] flex flex-col p-0 gap-0"
        zIndex="alert"
        onInteractOutside={() => onOpenChange(false)}
        onEscapeKeyDown={() => onOpenChange(false)}
        aria-describedby={undefined}
      >
        <DialogHeader className="px-4 py-3 relative border-b">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <List className="size-4" aria-hidden />
            对话目录
          </DialogTitle>
          <DialogClose
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1.5 hover:bg-muted transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="关闭"
          >
            <X className="size-4 text-muted-foreground" aria-hidden />
          </DialogClose>
        </DialogHeader>
        <div className="overflow-y-auto max-h-[calc(70vh-80px)]">
          <div className="p-3 pb-4 space-y-1">
            {items.map((item, tocIndex) => (
              <button
                key={item.index}
                type="button"
                onClick={() => onItemClick(item.index)}
                className={cn(
                  "w-full text-left px-3 py-2.5 rounded-md text-sm transition-colors",
                  "hover:bg-muted text-foreground",
                  "flex items-start gap-3",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                )}
              >
                <span className="session-toc-number">{tocIndex + 1}</span>
                <span className="line-clamp-2 leading-relaxed">
                  {item.preview}
                </span>
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
