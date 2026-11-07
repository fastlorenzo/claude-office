"use client";

/**
 * Actors debug page: characters cycling through every pose, a walking actor
 * in a real room layout, monitors, whiteboard, labels and a control-room wall.
 *
 * Query params:
 *   ?pose=typing   force every row character into one pose
 *   ?t=1.2         freeze animation time (deterministic screenshots)
 *   ?cam=row       camera preset (overview|row|face|room|boss|agent|board|wall)
 *   ?shot=1        render a fixed number of frames, then set title "READY"
 */

import { useEffect, useRef } from "react";

export default function ActorsDebugPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void import("./actorsScene").then(({ startActorsScene }) => {
      if (disposed) return;
      cleanup = startActorsScene(
        canvas,
        new URLSearchParams(window.location.search),
      );
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0b0e14" }}>
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          outline: "none",
        }}
      />
    </div>
  );
}
