import { readFileSync } from "node:fs";
import path from "node:path";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { list, parse, type Declaration, type Rule } from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);

beforeEach(() => {
  // cmdk and Radix scroll selected options in browsers; jsdom has no layout.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      scrollIntoViewDescriptor,
    );
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

describe("liquid glass primitive contracts", () => {
  it.each([
    "default",
    "secondary",
    "outline",
    "destructive",
    "ghost",
    "link",
    "mcp",
  ] as const)(
    "keeps the %s button variant and click behavior",
    async (variant) => {
      const onClick = vi.fn();
      render(
        <Button variant={variant} onClick={onClick}>
          Action
        </Button>,
      );
      const button = screen.getByRole("button", { name: "Action" });
      expect(button).toHaveClass(
        "glass-ui",
        "glass-button",
        "glass-button--" + variant,
        "h-9",
      );
      await userEvent.click(button);
      expect(onClick).toHaveBeenCalledOnce();
    },
  );

  it("preserves asChild, caller classes, refs and disabled buttons", async () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <>
        <Button asChild variant="link" className="caller-link">
          <a href="#details">Details</a>
        </Button>
        <Button ref={ref} disabled onClick={onClick} className="h-12">
          Unavailable
        </Button>
      </>,
    );
    const link = screen.getByRole("link", { name: "Details" });
    expect(link).toHaveClass("glass-button--link", "caller-link");
    expect(link).toHaveAttribute("href", "#details");
    const disabled = screen.getByRole("button", { name: "Unavailable" });
    expect(ref.current).toBe(disabled);
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveClass("h-12");
    expect(disabled).not.toHaveClass("h-9");
    await userEvent.click(disabled);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("adds card finishes without adding wrapper elements", () => {
    const { container } = render(
      <Card className="caller-card">
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Connection settings</CardDescription>
        </CardHeader>
        <CardContent>Readable body</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>,
    );
    expect(container.firstElementChild).toHaveClass(
      "glass-ui",
      "glass-card",
      "caller-card",
      "rounded-lg",
    );
    expect(container.firstElementChild?.children).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "Account" })).toHaveClass(
      "glass-card-title",
    );
    expect(screen.getByText("Connection settings")).toHaveClass(
      "glass-card-description",
    );
    expect(screen.getByText("Readable body")).toHaveClass("glass-card-content");
    expect(screen.getByText("Footer")).toHaveClass("glass-card-footer");
  });

  it("preserves input values, refs, invalid attributes and native validation", async () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    render(
      <>
        <Input
          ref={ref}
          aria-label="Endpoint"
          defaultValue="https://"
          aria-invalid="true"
          onChange={onChange}
        />
        <Textarea aria-label="Notes" defaultValue="Initial" />
        <Input aria-label="Required value" required />
        <Textarea aria-label="Disabled notes" disabled defaultValue="Locked" />
      </>,
    );
    const input = screen.getByRole("textbox", { name: "Endpoint" });
    const textarea = screen.getByRole("textbox", { name: "Notes" });
    expect(ref.current).toBe(input);
    expect(input).toHaveClass("glass-ui", "glass-input");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveValue("https://");
    expect(textarea).toHaveClass("glass-ui", "glass-textarea");
    await userEvent.type(input, "example.test");
    await userEvent.type(textarea, " notes");
    expect(input).toHaveValue("https://example.test");
    expect(textarea).toHaveValue("Initial notes");
    expect(onChange).toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Required value" }),
    ).toBeInvalid();
    expect(
      screen.getByRole("textbox", { name: "Disabled notes" }),
    ).toBeDisabled();
  });

  it("keeps checkbox and switch states, callbacks and keyboard operation", async () => {
    const onCheckedChange = vi.fn();
    render(
      <>
        <Checkbox
          aria-label="Enable backups"
          onCheckedChange={onCheckedChange}
        />
        <Checkbox aria-label="Mixed selection" checked="indeterminate" />
        <Switch aria-label="Enable routing" />
        <Switch aria-label="Unavailable switch" disabled />
      </>,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Enable backups" });
    const toggle = screen.getByRole("switch", { name: "Enable routing" });
    expect(checkbox).toHaveClass("glass-ui", "glass-checkbox");
    expect(
      screen.getByRole("checkbox", { name: "Mixed selection" }),
    ).toBePartiallyChecked();
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(checkbox).toHaveAttribute("data-state", "checked");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(toggle).toHaveClass("glass-ui", "glass-switch");
    expect(toggle.firstElementChild).toHaveClass("glass-switch-thumb");
    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
    await userEvent.keyboard(" ");
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Unavailable switch" }),
    ).toBeDisabled();
  });

  it("preserves tabs selection, panel relationships and disabled states", async () => {
    render(
      <Tabs defaultValue="first">
        <TabsList aria-label="Settings sections">
          <TabsTrigger value="first">General</TabsTrigger>
          <TabsTrigger value="second">Advanced</TabsTrigger>
          <TabsTrigger value="locked" disabled>
            Locked
          </TabsTrigger>
        </TabsList>
        <TabsContent value="first">General settings</TabsContent>
        <TabsContent value="second">Advanced settings</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole("tablist")).toHaveClass(
      "glass-ui",
      "glass-tabs-list",
    );
    const advanced = screen.getByRole("tab", { name: "Advanced" });
    expect(advanced).toHaveClass("glass-ui", "glass-tabs-trigger");
    await userEvent.click(advanced);
    expect(advanced).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Advanced" })).toHaveClass(
      "glass-ui",
      "glass-tabs-content",
    );
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Advanced settings");
    expect(screen.getByRole("tab", { name: "Locked" })).toBeDisabled();
  });

  it("keeps dialog content portalled, named and dismissible with Escape", async () => {
    const { container } = render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open settings</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Configure your account</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button>Done</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole("button", { name: "Open settings" });
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveClass("glass-ui", "glass-dialog");
    expect(dialog).toHaveAccessibleDescription("Configure your account");
    expect(container).not.toContainElement(dialog);
    expect(document.querySelector(".glass-dialog-overlay")).toHaveAttribute(
      "data-state",
      "open",
    );
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("retains the fullscreen dialog geometry classes", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent variant="fullscreen">
          <DialogTitle>Full screen</DialogTitle>
          <DialogDescription>Full screen content</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("dialog", { name: "Full screen" })).toHaveClass(
      "glass-dialog--fullscreen",
      "inset-0",
      "w-screen",
      "h-screen",
    );
  });

  it("keeps popover content clickable and portalled", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <Popover>
        <PopoverTrigger>Open popover</PopoverTrigger>
        <PopoverContent aria-label="Actions">
          <Button onClick={onClick}>Run action</Button>
        </PopoverContent>
      </Popover>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open popover" }));
    const popover = screen.getByRole("dialog", { name: "Actions" });
    expect(popover).toHaveClass("glass-ui", "glass-popover");
    expect(container).not.toContainElement(popover);
    await userEvent.click(screen.getByRole("button", { name: "Run action" }));
    expect(onClick).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps select value changes, disabled options and scroll bounds", async () => {
    const onValueChange = vi.fn();
    render(
      <Select defaultValue="one" onValueChange={onValueChange}>
        <SelectTrigger aria-label="Connection">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">Primary</SelectItem>
          <SelectItem value="two">Backup</SelectItem>
          <SelectItem value="locked" disabled>
            Unavailable
          </SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = screen.getByRole("combobox", { name: "Connection" });
    expect(trigger).toHaveClass("glass-ui", "glass-select-trigger");
    await userEvent.tab();
    await userEvent.keyboard("{ArrowDown}");
    const list = screen.getByRole("listbox");
    expect(list).toHaveClass(
      "glass-ui",
      "glass-select",
      "overflow-y-auto",
      "overflow-x-hidden",
      "max-h-[min(24rem,var(--radix-select-content-available-height))]",
    );
    expect(screen.getByRole("option", { name: "Unavailable" })).toHaveAttribute(
      "data-disabled",
    );
    const option = screen.getByRole("option", { name: "Backup" });
    expect(option).toHaveClass("glass-ui", "glass-select-item");
    await userEvent.click(option);
    expect(onValueChange).toHaveBeenCalledWith("two");
    expect(trigger).toHaveTextContent("Backup");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("preserves dropdown selection and checkbox item semantics", async () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>Connect</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked>Remember</DropdownMenuCheckboxItem>
          <DropdownMenuItem disabled>Unavailable</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await userEvent.tab();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu")).toHaveClass("glass-ui", "glass-dropdown");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Remember" }),
    ).toBeChecked();
    expect(
      screen.getByRole("menuitem", { name: "Unavailable" }),
    ).toHaveAttribute("data-disabled");
    const item = screen.getByRole("menuitem", { name: "Connect" });
    expect(item).toHaveClass("glass-ui", "glass-dropdown-item");
    await userEvent.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps command filtering, selection and disabled items", async () => {
    const onSelect = vi.fn();
    render(
      <Command aria-label="Quick actions">
        <CommandInput placeholder="Search actions" />
        <CommandList>
          <CommandEmpty>No results</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem value="connect" onSelect={onSelect}>
              Connect
            </CommandItem>
            <CommandItem value="disconnect" disabled>
              Disconnect
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    );
    const input = screen.getByRole("combobox");
    expect(input.closest("[cmdk-root]")).toHaveClass(
      "glass-ui",
      "glass-command",
    );
    expect(input).toHaveClass("glass-ui", "glass-command-input");
    expect(screen.getByRole("listbox")).toHaveClass("glass-command-list");
    expect(screen.getByRole("option", { name: "Disconnect" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.type(input, "missing");
    expect(screen.getByText("No results")).toHaveClass("glass-command-empty");
    await userEvent.clear(input);
    const option = screen.getByRole("option", { name: "Connect" });
    expect(option).toHaveClass("glass-ui", "glass-command-item");
    await userEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith("connect");
  });

  it("keeps tooltip descriptions available on keyboard focus", async () => {
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Explain</TooltipTrigger>
          <TooltipContent>Connection help</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Explain" });
    await userEvent.tab();
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Connection help");
    expect(tooltip.closest(".glass-tooltip")).toHaveClass("glass-ui");
    expect(trigger).toHaveAccessibleDescription("Connection help");
  });
});

describe("liquid glass stylesheet safeguards", () => {
  const stylesheet = parse(
    readFileSync(
      path.resolve(__dirname, "../../src/components/ui/liquid-glass-ui.css"),
      "utf8",
    ),
  );

  it("scopes finishes to semantic classes without redefining theme tokens or geometry", () => {
    stylesheet.walkRules((rule) => {
      expect(rule.selector).toContain(".glass-");
      expect(rule.selector).not.toMatch(
        /::(before|after)|(^|[,(>\s])(button|div|tr)(?=[.#:\s),]|$)/,
      );
    });
    stylesheet.walkDecls((declaration) => {
      expect(declaration.prop).not.toMatch(
        /^--|^(display|position|width|height|min-width|min-height|max-width|max-height|overflow|padding|margin|transform|pointer-events|z-index)(-|$)/,
      );
    });
  });

  it("uses the shared focus token and includes motion, forced-color and blur fallbacks", () => {
    const media: string[] = [];
    const supports: string[] = [];
    stylesheet.walkAtRules("media", (rule) => {
      media.push(rule.params);
    });
    stylesheet.walkAtRules("supports", (rule) => {
      supports.push(rule.params);
    });
    expect(media).toContain("(prefers-reduced-motion: reduce)");
    expect(media).toContain("(prefers-reduced-transparency: reduce)");
    expect(media).toContain("(prefers-reduced-transparency: reduce)");
    expect(media).toContain("(forced-colors: active)");
    expect(
      supports.some(
        (condition) =>
          condition.startsWith("not ") && condition.includes("backdrop-filter"),
      ),
    ).toBe(true);
    const focusRules: string[] = [];
    stylesheet.walkRules((rule) => {
      if (rule.selector.includes(":focus-visible"))
        focusRules.push(rule.toString());
    });
    expect(focusRules.some((rule) => rule.includes("var(--glass-focus,"))).toBe(
      true,
    );
    expect(stylesheet.toString()).toContain('[aria-invalid="true"]');
  });

  it("preserves caller-owned ghost action colors", () => {
    stylesheet.walkRules((rule) => {
      if (!rule.selector.includes(".glass-button--ghost")) return;
      if (
        rule.parent?.type === "atrule" &&
        rule.parent.params === "(forced-colors: active)"
      )
        return;
      rule.walkDecls("color", (declaration) => {
        throw new Error(
          "Ghost finish must not override semantic ink: " +
            declaration.toString(),
        );
      });
    });
  });

  it("separates functional checkbox boundaries from decorative glass borders", () => {
    const boundaries: string[] = [];
    stylesheet.walkRules((rule) => {
      if (!rule.selector.includes('.glass-checkbox[data-state="unchecked"]'))
        return;
      rule.walkDecls("border-color", (declaration) => {
        boundaries.push(declaration.value);
      });
    });
    expect(boundaries).toContain(
      "var(--glass-control-border, var(--border-control, #6c8194))",
    );
    expect(boundaries).not.toContain(
      "var(--glass-border, var(--border-control, #94a3b8))",
    );
  });

  it("uses the complete shared shadow token as a shadow list entry", () => {
    const sharedShadows: string[] = [];
    stylesheet.walkDecls("box-shadow", (declaration) => {
      for (const shadow of list.comma(declaration.value)) {
        if (!shadow.includes("--glass-shadow")) continue;
        sharedShadows.push(shadow);
        expect(shadow).toMatch(/^var\(--glass-shadow,/);
      }
    });
    expect(sharedShadows.length).toBeGreaterThan(0);
  });

  it("disables all blurred surfaces when reduced transparency is requested", () => {
    const blurredClasses = new Set<string>();
    const reducedClasses = new Set<string>();
    const semanticClasses = (selector: string) =>
      [...selector.matchAll(/\.glass-[\w-]+/g)]
        .map((match) => match[0])
        .filter((className) => className !== ".glass-ui");

    stylesheet.walkDecls(/backdrop-filter$/, (declaration) => {
      if (!declaration.value.includes("blur(")) return;
      const rule = declaration.parent;
      if (rule?.type !== "rule") return;
      semanticClasses(rule.selector).forEach((className) => {
        blurredClasses.add(className);
      });
    });
    stylesheet.walkAtRules("media", (media) => {
      if (media.params !== "(prefers-reduced-transparency: reduce)") return;
      media.walkRules((rule) => {
        const filters = new Map<string, string>();
        rule.walkDecls(/backdrop-filter$/, (declaration) => {
          filters.set(declaration.prop, declaration.value);
        });
        expect(filters.get("backdrop-filter")).toBe("none");
        expect(filters.get("-webkit-backdrop-filter")).toBe("none");
        semanticClasses(rule.selector).forEach((className) => {
          reducedClasses.add(className);
        });
      });
    });
    expect(blurredClasses.size).toBeGreaterThan(0);
    for (const className of blurredClasses) {
      expect(reducedClasses.has(className)).toBe(true);
    }
  });

  // These assertions exercise real selectors on shell-free portal-shaped nodes.
  // jsdom does not render media queries or backdrop filters.
  const declarationsInMedia = (element: Element, condition: string) => {
    const declarations = new Map<string, Declaration>();
    stylesheet.walkAtRules("media", (media) => {
      if (media.params !== condition) return;
      media.walkRules((rule) => {
        if (!element.matches(rule.selector)) return;
        rule.walkDecls((declaration) => {
          declarations.set(declaration.prop, declaration);
        });
      });
    });
    return declarations;
  };

  const portalSurfaces = [
    "glass-dialog",
    "glass-dialog glass-dialog--fullscreen",
    "glass-popover",
    "glass-select",
    "glass-dropdown",
    "glass-tooltip",
    "glass-command",
  ];

  const relativeLuminance = (hex: string) => {
    const digits = hex.slice(1);
    const expanded =
      digits.length === 3
        ? [...digits].map((digit) => digit + digit).join("")
        : digits;
    expect(expanded).toMatch(/^[a-f\d]{6}$/i);
    const linear = [0, 2, 4].map((offset) => {
      const channel = parseInt(expanded.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };

  it("uses opaque primary tokens for default, active and checked states, including hover and pressed", () => {
    const primaryRules: Rule[] = [];
    stylesheet.each((node) => {
      if (
        node.type === "rule" &&
        node.selector.includes(".glass-button--default")
      ) {
        primaryRules.push(node);
      }
    });
    expect(primaryRules).toHaveLength(3);
    const [base, hover, pressed] = primaryRules;
    for (const state of [
      '.glass-tabs-trigger[data-state="active"]',
      '.glass-switch[data-state="checked"]',
      '.glass-checkbox[data-state="checked"]',
      '.glass-checkbox[data-state="indeterminate"]',
    ])
      expect(base.selector).toContain(state);
    const declarations = new Map<string, string>();
    base.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
    expect(declarations.get("color")).toBe("#fff");
    expect(declarations.get("background-image")).toMatch(
      /linear-gradient\(\s*180deg,\s*var\(--glass-primary-top, #117cb9\),\s*var\(--glass-primary-bottom, #0866a3\)\s*\)/,
    );
    for (const rule of primaryRules) {
      const backgrounds: Declaration[] = [];
      rule.walkDecls(/^background/, (declaration) => {
        backgrounds.push(declaration);
      });
      expect(
        backgrounds.find(
          (declaration) => declaration.prop === "background-color",
        )?.value,
      ).toBe("var(--glass-primary-bottom, #0866a3)");
      expect(
        backgrounds.map((declaration) => declaration.value).join(" "),
      ).not.toMatch(/--glass-accent|rgb\(|transparent/);
    }
    for (const rule of [hover, pressed]) {
      expect(rule.selector.replace(/\s/g, "")).toContain(
        ':not(:disabled):not([aria-disabled="true"])',
      );
      expect(rule.toString()).toContain("background-image: none");
    }
    expect(hover.selector.trim()).toMatch(/:hover$/);
    expect(pressed.selector.trim()).toMatch(/:active$/);
  });

  it.each(["light", "dark"])(
    "keeps white primary text above WCAG AA across the %s gradient and hover/pressed fill",
    (mode) => {
      const theme = parse(
        readFileSync(
          path.resolve(__dirname, "../../src/theme/liquid-glass.css"),
          "utf8",
        ),
      );
      const colors = new Map<string, string>();
      theme.walkRules((rule) => {
        if (!rule.selectors.includes(mode === "light" ? ":root" : ".dark"))
          return;
        rule.walkDecls(/^--glass-primary-(top|bottom)$/, (declaration) => {
          colors.set(declaration.prop, declaration.value);
        });
      });
      const top = colors.get("--glass-primary-top");
      const bottom = colors.get("--glass-primary-bottom");
      expect(top).toBeDefined();
      expect(bottom).toBeDefined();
      if (!top || !bottom) throw new Error("Primary theme tokens are missing");
      const channels = (hex: string) =>
        [0, 2, 4].map((offset) =>
          parseInt(hex.slice(offset + 1, offset + 3), 16),
        );
      const topChannels = channels(top);
      const bottomChannels = channels(bottom);
      const white = relativeLuminance("#fff");
      // Include both endpoints (bottom is also the hover/pressed solid fill).
      for (let step = 0; step <= 100; step += 1) {
        const sample =
          "#" +
          topChannels
            .map((channel, index) =>
              Math.round(
                channel + ((bottomChannels[index] - channel) * step) / 100,
              )
                .toString(16)
                .padStart(2, "0"),
            )
            .join("");
        const contrast = (white + 0.05) / (relativeLuminance(sample) + 0.05);
        expect(contrast).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each([
    ["light", "#ffffff"],
    ["dark", "#1f2a36"],
  ])(
    "keeps an off switch visible on a %s card: thumb, track and edge at 3:1",
    (mode, card) => {
      const theme = parse(
        readFileSync(
          path.resolve(__dirname, "../../src/theme/liquid-glass.css"),
          "utf8",
        ),
      );
      const colors = new Map<string, string>();
      theme.walkRules((rule) => {
        if (!rule.selectors.includes(mode === "light" ? ":root" : ".dark"))
          return;
        rule.walkDecls(
          /^--glass-(switch-off-track|switch-off-thumb|control-border)$/,
          (declaration) => {
            colors.set(declaration.prop, declaration.value);
          },
        );
      });
      const track = colors.get("--glass-switch-off-track")!;
      const thumb = colors.get("--glass-switch-off-thumb")!;
      const edge = colors.get("--glass-control-border")!;
      const contrast = (a: string, b: string) => {
        const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
          (x, y) => y - x,
        );
        return (hi + 0.05) / (lo + 0.05);
      };
      // The reported bug: a white thumb on a near-white track.
      expect(thumb.toLowerCase()).not.toMatch(/^#f{3}(f{3})?$/);
      expect(contrast(thumb, track)).toBeGreaterThanOrEqual(3);
      expect(contrast(edge, card)).toBeGreaterThanOrEqual(3);

      // Every switch reads these through the --switch-* tokens.
      const tokens = readFileSync(
        path.resolve(__dirname, "../../src/theme/tokens.css"),
        "utf8",
      );
      expect(tokens).toMatch(
        /--switch-off-bg:\s*var\(--glass-switch-off-track\b/,
      );
      expect(tokens).toMatch(
        /--switch-thumb-off:\s*var\(--glass-switch-off-thumb\b/,
      );
      const thumbOff = document.createElement("span");
      thumbOff.className = "glass-switch-thumb";
      thumbOff.dataset.state = "unchecked";
      const decls = new Map<string, string>();
      stylesheet.walkRules((rule) => {
        if (rule.parent?.type !== "root" || !thumbOff.matches(rule.selector))
          return;
        rule.walkDecls((declaration) => {
          decls.set(declaration.prop, declaration.value);
        });
      });
      expect(decls.get("background-color")).toBe("var(--switch-thumb-off)");
      expect(decls.get("background-image")).toBe("none");
    },
  );

  it.each(portalSurfaces)(
    "removes blur and uses an opaque reduced-transparency backing on shell-free %s",
    (surface) => {
      const element = document.createElement("section");
      element.className = "glass-ui " + surface;
      const declarations = declarationsInMedia(
        element,
        "(prefers-reduced-transparency: reduce)",
      );
      expect(declarations.get("background-color")?.value).toBe(
        "var(--bg-surface, #f8fbff)",
      );
      expect(declarations.get("background-image")?.value).toBe("none");
      for (const property of ["backdrop-filter", "-webkit-backdrop-filter"]) {
        expect(declarations.get(property)?.value).toBe("none");
      }
    },
  );

  it("removes reduced-transparency overlay blur without removing the dimming backdrop", () => {
    const overlay = document.createElement("div");
    overlay.className = "glass-ui glass-dialog-overlay";
    const declarations = declarationsInMedia(
      overlay,
      "(prefers-reduced-transparency: reduce)",
    );
    expect(declarations.get("backdrop-filter")?.value).toBe("none");
    expect(declarations.get("-webkit-backdrop-filter")?.value).toBe("none");
    expect(declarations.has("background-color")).toBe(false);
  });

  it.each(["", "dark"])(
    "preserves opaque card fallbacks with the %s theme ancestor",
    (themeClass) => {
      const ancestor = document.createElement("div");
      ancestor.className = themeClass;
      const card = document.createElement("section");
      card.className = "glass-ui glass-card";
      ancestor.append(card);
      const declarations = declarationsInMedia(
        card,
        "(prefers-reduced-transparency: reduce)",
      );
      expect(declarations.get("background-color")?.value).toBe(
        "var(--bg-surface, #f8fbff)",
      );
      expect(declarations.get("background-image")?.value).toBe("none");
      expect(declarations.get("backdrop-filter")?.value).toBe("none");
      const darkFallbacks: string[] = [];
      stylesheet.walkAtRules("supports", (supports) => {
        if (!supports.params.startsWith("not ")) return;
        supports.walkRules((rule) => {
          if (rule.selector.includes(".dark .glass-ui.glass-card"))
            darkFallbacks.push(rule.toString());
        });
      });
      expect(darkFallbacks).toHaveLength(1);
      expect(darkFallbacks[0]).toContain("background-image: none");
    },
  );

  it.each([...portalSurfaces, "glass-dialog-overlay"])(
    "uses forced system colors and disables portal blur on shell-free %s",
    (surface) => {
      const element = document.createElement("section");
      element.className = "glass-ui " + surface;
      const declarations = declarationsInMedia(
        element,
        "(forced-colors: active)",
      );
      for (const [property, value] of Object.entries({
        "background-color": "Canvas",
        "background-image": "none",
        color: "CanvasText",
        "box-shadow": "none",
        "backdrop-filter": "none",
        "-webkit-backdrop-filter": "none",
      })) {
        expect(declarations.get(property)?.value).toBe(value);
        expect(declarations.get(property)?.important).toBe(true);
      }
    },
  );

  it("retains forced-color selection, disabled and visible focus semantics", () => {
    const states: [string, Record<string, string>][] = [
      ["glass-button--default", {}],
      ["glass-tabs-trigger", { "data-state": "active" }],
      ["glass-switch", { "data-state": "checked" }],
      ["glass-checkbox", { "data-state": "checked" }],
      ["glass-checkbox", { "data-state": "indeterminate" }],
      ["glass-select-item", { "data-highlighted": "" }],
      ["glass-dropdown-item", { "data-highlighted": "" }],
      ["glass-command-item", { "data-selected": "true" }],
    ];
    for (const [className, attributes] of states) {
      const element = document.createElement("button");
      element.className = "glass-ui " + className;
      for (const [name, value] of Object.entries(attributes))
        element.setAttribute(name, value);
      const declarations = declarationsInMedia(
        element,
        "(forced-colors: active)",
      );
      expect(declarations.get("background-color")?.value).toBe("Highlight");
      expect(declarations.get("color")?.value).toBe("HighlightText");
      expect(declarations.get("forced-color-adjust")?.value).toBe("none");
      element.disabled = true;
      const disabled = declarationsInMedia(element, "(forced-colors: active)");
      expect(disabled.get("color")?.value).toBe("GrayText");
      expect(disabled.get("opacity")?.value).toBe("1");
    }
    const focusOutlines: Declaration[] = [];
    stylesheet.walkAtRules("media", (media) => {
      if (media.params !== "(forced-colors: active)") return;
      media.walkRules((rule) => {
        if (rule.selector === ".glass-ui:focus-visible")
          rule.walkDecls("outline", (declaration) => {
            focusOutlines.push(declaration);
          });
      });
    });
    expect(focusOutlines).toHaveLength(1);
    expect(focusOutlines[0].value).toBe("2px solid Highlight");
    expect(focusOutlines[0].important).toBe(true);
  });

  it("limits backdrop blur to outer surfaces, never items, inputs or rows", () => {
    stylesheet.walkDecls(/backdrop-filter$/, (declaration) => {
      if (!declaration.value.includes("blur(")) return;
      const rule = declaration.parent;
      expect(rule?.type).toBe("rule");
      if (rule?.type !== "rule") return;
      expect(rule.selector).toMatch(
        /\.glass-(card|dialog|popover|select|dropdown|tooltip)/,
      );
      expect(rule.selector).not.toMatch(
        /item|input|textarea|tabs|switch|checkbox|\btr\b/,
      );
    });
  });
});

describe("liquid glass page cascade safeguards", () => {
  const shell = parse(
    readFileSync(
      path.resolve(__dirname, "../../src/theme/liquid-glass.css"),
      "utf8",
    ),
  );
  const pages = parse(
    readFileSync(
      path.resolve(__dirname, "../../src/theme/liquid-glass-pages.css"),
      "utf8",
    ),
  );

  it("keeps capability selection above the legacy navigation hover rule", () => {
    const selections: string[] = [];
    shell.walkRules((rule) => {
      if (
        rule.selector.includes(
          '[data-pencil-name^="能力 · "][aria-current="page"]::before',
        )
      )
        selections.push(rule.selector);
    });
    expect(selections).toHaveLength(2);
    selections.forEach((selector) =>
      expect(selector).toContain(".chimera-navigation"),
    );
  });

  it("keeps lazy page canvases below the material layer", () => {
    const canvases: string[] = [];
    pages.walkRules((rule) => {
      if (
        /\.prompts-page\s*,/.test(rule.selector) &&
        rule.selector.includes(".runtime-reference-view")
      )
        canvases.push(rule.selector);
    });
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatch(/^\.chimera-shell\s+:is\(/);
  });

  it("preserves explicit system selection colours for every selected navigation item", () => {
    const normalize = (selector: string) =>
      selector.replace(/\s+/g, " ").trim();
    const selections: Rule[] = [];
    shell.walkAtRules("media", (media) => {
      if (media.params !== "(forced-colors: active)") return;
      media.walkRules((rule) => {
        if (
          list
            .comma(rule.selector)
            .map(normalize)
            .includes('.chimera-shell .chimera-nav-item[aria-current="page"]')
        )
          selections.push(rule);
      });
    });
    expect(selections).toHaveLength(1);
    // Highlight-filled controls need the same treatment, or the forced-colour
    // backplate hides their HighlightText label.
    expect(list.comma(selections[0].selector).map(normalize)).toEqual(
      expect.arrayContaining([
        ".chimera-shell .provider-table-row.is-current",
        ".chimera-shell button.primary",
        ".chimera-shell .provider-page-heading button.provider-add",
      ]),
    );
    const declarations = new Map<string, string>();
    selections[0].walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
    expect(declarations.get("forced-color-adjust")).toBe("none");
    expect(declarations.get("color")).toBe("HighlightText");
  });

  it("keeps a contrasting keyboard focus ring on both selected navigation surfaces", () => {
    const focused: Rule[] = [];
    shell.walkAtRules("media", (media) => {
      if (media.params !== "(forced-colors: active)") return;
      media.walkRules((rule) => {
        if (rule.selector.includes(":focus-visible")) focused.push(rule);
      });
    });
    expect(focused).toHaveLength(1);
    const selectors = list
      .comma(focused[0].selector)
      .map((selector) =>
        selector
          .replace(/\s+/g, " ")
          .replace(/\(\s+/g, "(")
          .replace(/\s+\)/g, ")")
          .trim(),
      );
    expect(selectors).toEqual([
      '.chimera-shell .chimera-nav-item[aria-current="page"]:not([data-pencil-name^="能力 · "]):focus-visible',
      '.chimera-shell .chimera-sidebar .chimera-navigation .chimera-nav-item[data-pencil-name^="能力 · "][aria-current="page"]:focus-visible::before',
    ]);
    const declarations = new Map<string, string>();
    focused[0].walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
    expect(declarations.get("outline")).toBe("2px solid HighlightText");
    expect(declarations.get("outline-offset")).toBe("-2px");
  });

  it("removes the primary gradient before using accent ink on advanced usage tabs", () => {
    const backgrounds: string[] = [];
    pages.walkRules((rule) => {
      if (
        rule.selector !==
        '.usage-advanced-body [role="tab"][data-state="active"]'
      )
        return;
      rule.walkDecls("background-image", (declaration) => {
        backgrounds.push(declaration.value);
      });
    });
    expect(backgrounds).toEqual(["none"]);
  });
});
