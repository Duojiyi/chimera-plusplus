import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { ProviderIcon } from "@/components/ProviderIcon";
import { IconPicker } from "@/components/IconPicker";
import { getIconMetadata } from "@/icons/extracted/metadata";
import type { UseFormReturn } from "react-hook-form";
import type { ProviderFormData } from "@/lib/schemas/provider";

interface BasicFormFieldsProps {
  form: UseFormReturn<ProviderFormData>;
  /** Slot to render content between icon and name fields */
  beforeNameSlot?: ReactNode;
}

export function BasicFormFields({
  form,
  beforeNameSlot,
}: BasicFormFieldsProps) {
  const { t } = useTranslation();
  const [iconDialogOpen, setIconDialogOpen] = useState(false);

  const moreInfoRef = useRef<HTMLDetailsElement>(null);
  const { errors, submitCount } = form.formState;
  useEffect(() => {
    if ((errors.websiteUrl || errors.notes) && moreInfoRef.current) {
      moreInfoRef.current.open = true;
    }
  }, [errors.websiteUrl, errors.notes, submitCount]);

  const currentIcon = form.watch("icon");
  const currentIconColor = form.watch("iconColor");
  const providerName = form.watch("name") || "Provider";
  const effectiveIconColor =
    currentIconColor ||
    (currentIcon ? getIconMetadata(currentIcon)?.defaultColor : undefined);

  const handleIconSelect = (icon: string) => {
    const meta = getIconMetadata(icon);
    form.setValue("icon", icon);
    form.setValue("iconColor", meta?.defaultColor ?? "");
  };

  return (
    <>
      {beforeNameSlot}
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("provider.name")}</FormLabel>
            <FormControl>
              <Input {...field} placeholder="例如：我的工作线路" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <details
        ref={moreInfoRef}
        className="rounded-lg border border-border px-4 py-3"
      >
        <summary className="cursor-pointer text-sm text-muted-foreground">
          更多信息 · 图标、备注、官网
        </summary>
        <div className="mt-4 space-y-4">
          {/* 图标选择区域 - 顶部居中，可选 */}
          <div className="flex items-center gap-3">
            <Dialog open={iconDialogOpen} onOpenChange={setIconDialogOpen}>
              <DialogTrigger asChild>
                <button
                  type="button"
                  className="h-10 w-10 rounded-md border border-input hover:border-primary transition-colors bg-muted/30 flex items-center justify-center"
                  aria-label="修改线路图标"
                  title={
                    currentIcon
                      ? t("providerIcon.clickToChange", {
                          defaultValue: "点击更换图标",
                        })
                      : t("providerIcon.clickToSelect", {
                          defaultValue: "点击选择图标",
                        })
                  }
                >
                  <ProviderIcon
                    icon={currentIcon}
                    name={providerName}
                    color={effectiveIconColor}
                    size={24}
                  />
                </button>
              </DialogTrigger>
              <DialogContent
                variant="fullscreen"
                zIndex="top"
                overlayClassName="bg-[hsl(var(--background))] backdrop-blur-0"
                className="p-0 sm:rounded-none"
              >
                <div className="flex h-full flex-col">
                  <div className="flex-shrink-0 py-4 border-b border-border-default bg-muted/40">
                    <div className="px-6 flex items-center gap-4">
                      <DialogClose asChild>
                        <Button type="button" variant="outline" size="icon">
                          <ArrowLeft className="h-4 w-4" />
                        </Button>
                      </DialogClose>
                      <p className="text-lg font-semibold leading-tight">
                        {t("providerIcon.selectIcon", {
                          defaultValue: "选择图标",
                        })}
                      </p>
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    <div className="space-y-2 px-6 py-6 w-full">
                      <IconPicker
                        value={currentIcon}
                        onValueChange={handleIconSelect}
                        color={effectiveIconColor}
                      />
                      <div className="flex justify-end gap-2">
                        <DialogClose asChild>
                          <Button type="button" variant="outline">
                            {t("common.done", { defaultValue: "完成" })}
                          </Button>
                        </DialogClose>
                      </div>
                    </div>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
            <span className="text-sm text-muted-foreground">
              线路图标（可选）
            </span>
          </div>

          <FormField
            control={form.control}
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("provider.notes")}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    placeholder={t("provider.notesPlaceholder")}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="websiteUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("provider.websiteUrl")}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    placeholder={t("providerForm.websiteUrlPlaceholder")}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </details>
    </>
  );
}
