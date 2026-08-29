"use client";

import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { PreparedBuilding } from "./Buildings";

/**
 * Selección de etiquetas visibles.
 *
 * El prototipo anterior creaba un sprite por edificio con `depthTest:false`, así que los
 * 49 nombres se dibujaban encima de todo y a la vez, atravesando paredes. Mostrar solo
 * las N más cercanas tampoco basta: los edificios del campus están tan juntos que las
 * etiquetas se pisan igual. Aquí se proyectan a pantalla y se descartan las que caerían
 * encima de una ya aceptada, de cerca a lejos.
 */

const MAX_VISIBLE = 9;
/** Recalcular cada frame es innecesario; a ~6 Hz no se percibe el salto. */
const REFRESH_MS = 160;
/** Alto de una etiqueta más margen, en px. */
const LABEL_HEIGHT = 24;

/**
 * Ancho aproximado de la etiqueta en px. Un umbral fijo no sirve: "La Pecera" y
 * "12. José Gabriel Maldonado S.J. - Laboratorios" se dibujan con anchos muy distintos,
 * y con un valor único o se solapan los nombres largos o se descartan de más los cortos.
 */
function labelHalfWidth(name: string): number {
  return (name.length * 6.1 + 22) / 2;
}

type Anchor = { id: string; name: string; position: THREE.Vector3 };

type Props = {
  prepared: PreparedBuilding[];
  selectedId: string | null;
  hoveredId: string | null;
  showLabels: boolean;
  campusRadius: number;
  /** Franja izquierda tapada por la barra lateral; ahí no se colocan etiquetas. */
  sidebarWidth: number;
};

export function Labels({
  prepared,
  selectedId,
  hoveredId,
  showLabels,
  campusRadius,
  sidebarWidth,
}: Props) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const [visible, setVisible] = useState<string[]>([]);
  const lastRun = useRef(0);
  const scratch = useRef(new THREE.Vector3());

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

    // Corte generoso: quien mantiene las etiquetas legibles es el rechazo por
    // solapamiento de más abajo, no la distancia. Un corte estrecho las hacía
    // desaparecer casi todas en la vista general, que es justo donde más se necesitan.
    const maxDistance = campusRadius * 3.5;

    const candidates: { id: string; d: number; x: number; y: number; hw: number }[] = [];
    for (const a of anchors) {
      const d = camera.position.distanceTo(a.position);
      if (d > maxDistance) continue;

      const ndc = scratch.current.copy(a.position).project(camera);
      // Detrás de la cámara o fuera del frustum.
      if (ndc.z > 1 || ndc.x < -1.1 || ndc.x > 1.1 || ndc.y < -1.1 || ndc.y > 1.1) continue;

      const x = ((ndc.x + 1) / 2) * size.width;
      const hw = labelHalfWidth(a.name);
      // Una etiqueta que cae bajo la barra lateral es una etiqueta perdida:
      // se dibuja detrás del panel y no la ve nadie.
      if (x - hw < sidebarWidth) continue;

      candidates.push({
        id: a.id,
        d,
        x,
        y: ((1 - ndc.y) / 2) * size.height,
        hw,
      });
    }

    candidates.sort((a, b) => a.d - b.d);

    const accepted: typeof candidates = [];
    for (const c of candidates) {
      if (accepted.length >= MAX_VISIBLE) break;
      const collides = accepted.some(
        (o) => Math.abs(o.x - c.x) < o.hw + c.hw && Math.abs(o.y - c.y) < LABEL_HEIGHT,
      );
      if (!collides) accepted.push(c);
    }

    const ids = accepted.map((a) => a.id);
    if (ids.length !== visible.length || ids.some((id, i) => id !== visible[i])) {
      setVisible(ids);
    }
  });

  // El seleccionado y el que está bajo el cursor siempre se muestran, aunque el
  // filtro de solapamiento los hubiera descartado.
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
