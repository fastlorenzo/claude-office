"use client";

import { useRef, useState, type ReactNode } from "react";
import { usePreferencesStore } from "@/stores/preferencesStore";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import {
  DEFAULT_BRANDING,
  MAX_NAME_CHARS,
  MAX_TAGLINE_CHARS,
  NEON_PALETTE,
  parseNeonColor,
  type NeonPaletteName,
} from "@/engine/world/brandLayout";
import { processLogoFile } from "@/engine/world/brandLogo";

const SWATCHES = Object.keys(NEON_PALETTE) as NeonPaletteName[];

const inputCls =
  "w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm placeholder:text-slate-500 focus:border-purple-500 outline-none";
const labelCls =
  "block text-slate-400 text-xs font-bold uppercase tracking-wider mb-2";

export function BrandingTab(): ReactNode {
  const { t } = useTranslation();
  const name = usePreferencesStore((s) => s.brandName);
  const tagline = usePreferencesStore((s) => s.brandTagline);
  const logo = usePreferencesStore((s) => s.brandLogo);
  const color = usePreferencesStore((s) => s.brandNeonColor);
  const flicker = usePreferencesStore((s) => s.brandFlicker);
  const st = usePreferencesStore.getState;
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [customHex, setCustomHex] = useState(color);

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setError(null);
    const res = await processLogoFile(file);
    if (res.ok) await st().setBrandLogo(res.dataUrl);
    else
      setError(
        res.error === "tooLarge"
          ? t("settings.brand.logoErrLarge")
          : res.error === "type"
            ? t("settings.brand.logoErrType")
            : t("settings.brand.logoErr"),
      );
    if (fileRef.current) fileRef.current.value = "";
  };

  const isPalette = SWATCHES.some((n) => NEON_PALETTE[n] === color);

  return (
    <div className="space-y-6">
      <p className="text-slate-500 text-xs">{t("settings.brand.desc")}</p>

      <div>
        <label className={labelCls} htmlFor="brand-name">
          {t("settings.brand.name")}
        </label>
        <input
          id="brand-name"
          className={inputCls}
          value={name}
          maxLength={MAX_NAME_CHARS}
          placeholder={t("settings.brand.namePlaceholder")}
          onChange={(e) => st().setBrandName(e.target.value)}
        />
      </div>

      <div>
        <label className={labelCls} htmlFor="brand-tagline">
          {t("settings.brand.tagline")}
        </label>
        <input
          id="brand-tagline"
          className={inputCls}
          value={tagline}
          maxLength={MAX_TAGLINE_CHARS}
          placeholder={t("settings.brand.taglinePlaceholder")}
          onChange={(e) => st().setBrandTagline(e.target.value)}
        />
      </div>

      <div>
        <span className={labelCls}>{t("settings.brand.logo")}</span>
        <div className="flex items-center gap-3">
          <div
            className="w-16 h-16 rounded-lg border border-slate-700 bg-slate-950 flex items-center justify-center overflow-hidden"
            style={{ boxShadow: `0 0 14px ${color}55` }}
          >
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="" className="max-w-full max-h-full" />
            ) : (
              <span style={{ color, textShadow: `0 0 8px ${color}` }}>
                &#10022;
              </span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold"
              >
                {logo
                  ? t("settings.brand.logoReplace")
                  : t("settings.brand.logoUpload")}
              </button>
              {logo && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    void st().setBrandLogo("");
                  }}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 hover:border-slate-600 text-slate-300 text-xs font-bold"
                >
                  {t("settings.brand.logoRemove")}
                </button>
              )}
            </div>
            <p className="text-slate-500 text-xs">
              {t("settings.brand.logoHint")}
            </p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/svg+xml,image/jpeg"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </div>
        {error && (
          <p role="alert" className="mt-2 text-xs text-red-400">
            {error}
          </p>
        )}
      </div>

      <div>
        <span className={labelCls}>{t("settings.brand.color")}</span>
        <div className="flex flex-wrap items-center gap-2">
          {SWATCHES.map((n) => {
            const hex = NEON_PALETTE[n];
            const active = color === hex;
            return (
              <button
                key={n}
                type="button"
                aria-label={t(`settings.brand.c.${n}` as TranslationKey)}
                title={t(`settings.brand.c.${n}` as TranslationKey)}
                aria-pressed={active}
                onClick={() => {
                  setCustomHex(hex);
                  void st().setBrandNeonColor(hex);
                }}
                className={`w-8 h-8 rounded-full border-2 transition-transform ${
                  active
                    ? "border-white scale-110"
                    : "border-slate-700 hover:border-slate-500"
                }`}
                style={{ background: hex, boxShadow: `0 0 10px ${hex}88` }}
              />
            );
          })}
          <label
            className={`flex items-center gap-2 pl-1 text-xs ${
              isPalette ? "text-slate-500" : "text-slate-200"
            }`}
          >
            {t("settings.brand.colorCustom")}
            <input
              type="color"
              value={parseNeonColor(customHex) ?? DEFAULT_BRANDING.color}
              onChange={(e) => {
                setCustomHex(e.target.value);
                void st().setBrandNeonColor(e.target.value);
              }}
              className="w-8 h-8 rounded bg-transparent border border-slate-700 cursor-pointer"
            />
          </label>
        </div>
      </div>

      <div
        role="switch"
        aria-checked={flicker}
        aria-label={t("settings.brand.flicker")}
        tabIndex={0}
        onClick={() => void st().setBrandFlicker(!flicker)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void st().setBrandFlicker(!flicker);
          }
        }}
        className="flex items-center justify-between p-2.5 rounded-lg bg-slate-800 border border-slate-700 cursor-pointer hover:border-slate-600 transition-colors"
      >
        <span className="text-slate-300 text-sm">
          {t("settings.brand.flicker")}
        </span>
        <div
          className={`w-9 h-5 rounded-full relative transition-colors ${
            flicker ? "bg-purple-500" : "bg-slate-600"
          }`}
        >
          <div
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-md transition-transform ${
              flicker ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={() => {
          const s = st();
          s.setBrandName(DEFAULT_BRANDING.name);
          s.setBrandTagline("");
          setCustomHex(DEFAULT_BRANDING.color);
          void s.setBrandLogo("");
          void s.setBrandNeonColor(DEFAULT_BRANDING.color);
          void s.setBrandFlicker(false);
        }}
        className="text-xs text-slate-400 hover:text-slate-200 underline"
      >
        {t("settings.brand.reset")}
      </button>
    </div>
  );
}
