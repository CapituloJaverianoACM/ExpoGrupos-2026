"use client";

import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { PreparedBuilding } from "./Buildings";

/**
 * El prototipo anterior creaba un sprite por edificio con `depthTest:false`, así que los
 * 49 nombres se dibujaban encima de todo y a la vez, atravesando paredes. Aquí solo se
 * muestran los MAX_VISIBLE más cercanos a la cámara, más el seleccionado y el que está
 * bajo el cursor, que siempre ganan.
 */
const MAX_VISIBLE = 10;
/** Recalcular el ranking cada frame es innecesario; a 6 Hz no se nota el salto. */
const REFRESH_MS = 160;

type Anchor = {
  id: string;
  name: string;
  position: THREE.Vector3;
};

type Props = {
  prepared: PreparedBuilding[];
  selectedId: string | null;
  hoveredId: string | null;
  showLabels: boolean;
};

export function Labels({ prepared, selectedId, hoveredId, showLabels }: Props) {
  const camera = useThree((s) => s.camera);
  const [visible, setVisible] = useState<string[]>([]);
  const lastRun = useRef(0);

  const anchors = useMemo<Anchor[]>(
    () =>
      prepared
        .filter((p) => p.building.name !== null && !p.building.isPart)
        .map((p) => ({
          id: p.building.id,
          name: p.building.name as string,
          position: new THREE.Vector3(
            p.geometry.center[0],
            p.geometry.top + 4,
            p.geometry.center[1],
          ),
        })),
    [prepared],
  );

  useFrame(() => {
    if (!showLabels) {
      if (visible.length) setVisible([]);
      return;
    }
    const now = performance.now();
    if (now - lastRun.current < REFRESH_MS) return;
    lastRun.current = now;

    const ranked = anchors
      .map((a) => ({ id: a.id, d: camera.position.distanceToSquared(a.position) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_VISIBLE)
      .map((a) => a.id);

    // Evita re-render si el conjunto no cambió.
    if (ranked.length !== visible.length || ranked.some((id, i) => id !== visible[i])) {
      setVisible(ranked);
    }
  });

  const shown = new Set(visible);
  if (selectedId) shown.add(selectedId);
  if (hoveredId) shown.add(hoveredId);

  return (
    <>
      {anchors
        .filter((a) => shown.has(a.id))
        .map((a) => {
          const active = a.id === selectedId || a.id === hoveredId;
          return (
            <Html
              key={a.id}
              position={a.position}
              center
              // occlude:false + zIndexRange bajo: la etiqueta no debe robar clics al canvas.
              zIndexRange={[20, 0]}
              style={{ pointerEvents: "none" }}
            >
              <div
                className={[
                  "whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium leading-none",
                  "backdrop-blur-sm transition-colors duration-150",
                  active
                    ? "border-orange-400/70 bg-orange-500/25 text-orange-50 shadow-lg shadow-orange-900/40"
                    : "border-white/15 bg-slate-950/70 text-slate-200",
                ].join(" ")}
              >
                {a.name}
              </div>
            </Html>
          );
        })}
    </>
  );
}
