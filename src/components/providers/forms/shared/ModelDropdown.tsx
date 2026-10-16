import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FetchedModel } from "@/lib/api/model-fetch";

export function ModelDropdown({
  models,
  onSelect,
  variant = "button",
  label = "选择模型",
}: {
  models: FetchedModel[];
  onSelect: (id: string) => void;
  /** `addon`: a plain side button inside a `.model-input` field group. */
  variant?: "button" | "addon";
  /** Accessible name of the trigger. */
  label?: string;
}) {
  const grouped: Record<string, FetchedModel[]> = {};
  for (const model of models) {
    const vendor = model.ownedBy || "Other";
    if (!grouped[vendor]) grouped[vendor] = [];
    grouped[vendor].push(model);
  }
  const vendors = Object.keys(grouped).sort();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "addon" ? (
          <button type="button" aria-label={label} title={label}>
            <ChevronDown size={15} aria-hidden="true" />
          </button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0"
            aria-label={label}
            title={label}
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-64 overflow-y-auto z-[200]"
      >
        {vendors.map((vendor, vi) => (
          <div key={vendor}>
            {vi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{vendor}</DropdownMenuLabel>
            {grouped[vendor].map((m) => (
              <DropdownMenuItem key={m.id} onSelect={() => onSelect(m.id)}>
                {m.id}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
