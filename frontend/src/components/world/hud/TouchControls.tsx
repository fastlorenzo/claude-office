"use client";

import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Menu, Video } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { useWorldUiStore } from "@/stores/worldUiStore";
import { getWorld } from "../worldRef";
import { GLASS } from "./glass";

const BASE = 132;
const KNOB = 56;
const RADIUS = (BASE - KNOB) / 2 + 8;

function Joystick(): ReactNode {
  const origin = useRef<{ id: number; x: number; y: number } | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0, active: false });

  const update = (e: PointerEvent<HTMLDivElement>): void => {
    const o = origin.current;
    if (!o || o.id !== e.pointerId) return;
    let dx = e.clientX - o.x;
    let dy = e.clientY - o.y;
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) {
      dx = (dx / len) * RADIUS;
      dy = (dy / len) * RADIUS;
    }
    setKnob({ x: dx, y: dy, active: true });
    // x: right = +1, y: forward (screen up) = +1
    getWorld()?.setVirtualMove(dx / RADIUS, -dy / RADIUS);
  };

  const end = (e: PointerEvent<HTMLDivElement>): void => {
    if (origin.current?.id !== e.pointerId) return;
    origin.current = null;
    setKnob({ x: 0, y: 0, active: false });
    getWorld()?.setVirtualMove(0, 0);
  };

  return (
    <div
      className="pointer-events-auto absolute bottom-6 left-6 touch-none rounded-full border border-white/15 bg-slate-950/50 backdrop-blur-md"
      style={{ width: BASE, height: BASE }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const r = e.currentTarget.getBoundingClientRect();
        origin.current = {
          id: e.pointerId,
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
        };
        update(e);
      }}
      onPointerMove={update}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div
        className="absolute rounded-full bg-[#D97757]/80 shadow-lg shadow-black/40"
        style={{
          width: KNOB,
          height: KNOB,
          left: (BASE - KNOB) / 2 + knob.x,
          top: (BASE - KNOB) / 2 + knob.y,
          transition: knob.active ? "none" : "all 120ms ease-out",
        }}
      />
    </div>
  );
}

function ActionButton({
  children,
  onPress,
  accent = false,
  label,
}: {
  children: ReactNode;
  onPress: () => void;
  accent?: boolean;
  label: string;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        onPress();
      }}
      className={`pointer-events-auto flex h-14 min-w-14 touch-none items-center justify-center rounded-full px-3 text-base font-bold text-white active:scale-95 ${
        accent ? "bg-[#D97757]/90" : GLASS
      }`}
    >
      {children}
    </button>
  );
}

export function TouchControls(): ReactNode {
  const { t } = useTranslation();
  const ready = useWorldUiStore((s) => s.ready);
  const panelOpen = useWorldUiStore((s) => s.panels.length > 0);
  const toggle = useWorldUiStore((s) => s.toggle);
  const look = useRef<{ id: number; x: number; y: number } | null>(null);

  if (!ready) return null;

  const trigger = (key: "F" | "Enter"): void => {
    const prompt = useWorldUiStore.getState().prompt;
    const fallback = key === "F" ? "inspect" : "enter";
    getWorld()?.triggerAction(
      prompt?.actions.find((a) => a.key === key)?.id ?? fallback,
    );
  };

  const toggleCamera = (): void => {
    const ui = useWorldUiStore.getState();
    getWorld()?.setCameraMode(ui.cameraMode === "fp" ? "tp" : "fp");
  };

  return (
    <div className="pointer-events-none absolute inset-0">
      {!panelOpen && (
        <>
          {/* Right-half look surface (below the buttons) */}
          <div
            className="pointer-events-auto absolute inset-y-0 right-0 w-1/2 touch-none"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              look.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
            }}
            onPointerMove={(e) => {
              const l = look.current;
              if (!l || l.id !== e.pointerId) return;
              getWorld()?.addLook(e.clientX - l.x, e.clientY - l.y);
              l.x = e.clientX;
              l.y = e.clientY;
            }}
            onPointerUp={() => (look.current = null)}
            onPointerCancel={() => (look.current = null)}
          />
          <Joystick />
          <div className="absolute bottom-6 right-5 flex flex-col items-end gap-3">
            <ActionButton
              label={t("hud.touch.enter")}
              accent
              onPress={() => trigger("Enter")}
            >
              {t("hud.touch.enter")}
            </ActionButton>
            <div className="flex gap-3">
              <ActionButton
                label={t("hud.touch.camera")}
                onPress={toggleCamera}
              >
                <Video className="h-5 w-5" />
              </ActionButton>
              <ActionButton label="F" accent onPress={() => trigger("F")}>
                F
              </ActionButton>
            </div>
          </div>
        </>
      )}
      <div className="absolute right-3 top-14">
        <ActionButton
          label={t("hud.touch.menu")}
          onPress={() => toggle("sessions")}
        >
          <Menu className="h-5 w-5" />
        </ActionButton>
      </div>
    </div>
  );
}
