"use client";

import { Html } from "@react-three/drei";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { shapeToWorldXZ } from "@/lib/geometry";
import type { Access, PlacesData, Service } from "@/lib/types";

/**
 * Accesos (entradas, porterías, torniquetes) y servicios del campus.
 *
 * Estos NO son arquitectura: son símbolos sobre el modelo. Por eso usan
 * MeshBasicMaterial con `toneMapped = false` — no reciben luz ni sombra y su color
 * llega a pantalla sin pasar por ACES. Un marcador que se oscurece cuando le da la
 * sombra de un edificio deja de cumplir su función, que es ser visible.
 */

const ACCESS_COLOUR: Record<string, string> = {
  entrance: "#4fd1a5",
  gate: "#ffc061",
  lift_gate: "#ffc061",
  sliding_gate: "#ffc061",
  // El control de acceso estricto se distingue del portón: es donde se pasa el carné.
  turnstile: "#ff8a5c",
};

const SERVICE_COLOUR: Record<string, string> = {
  comida: "#ff9f43",
  dinero: "#5bc0eb",
  estudio: "#7ec8e3",
  cultura: "#c792ea",
  salud: "#ff6b6b",
  movilidad: "#9aa4ad",
  servicios: "#a0d468",
};

export const SERVICE_LEGEND = Object.keys(SERVICE_COLOUR);
export { SERVICE_COLOUR };

/** Altura del marcador. Suficiente para despegarlo del suelo sin tapar la planta baja. */
const PIN_HEIGHT = 6;
const HEAD_RADIUS = 1.5;

/**
 * Geometría del marcador: mástil fino + rombo en la punta, fusionados en una sola
 * malla para que cada grupo sea UN draw call por muchos puntos que haya.
 */
function usePinGeometry() {
  return useMemo(() => {
    // CylinderGeometry viene indexada y OctahedronGeometry (como todo PolyhedronGeometry)
    // NO lo está. mergeGeometries exige que o todas tengan índice o ninguna, así que
    // hay que desindexar el mástil antes de fusionar.
    const indexedStem = new THREE.CylinderGeometry(0.16, 0.16, PIN_HEIGHT, 5);
    indexedStem.translate(0, PIN_HEIGHT / 2, 0);
    const stem = indexedStem.toNonIndexed();
    indexedStem.dispose();

    const head = new THREE.OctahedronGeometry(HEAD_RADIUS, 0);
    head.translate(0, PIN_HEIGHT + HEAD_RADIUS * 0.6, 0);

    const merged = mergeGeometries([stem, head], false);
    stem.dispose();
    head.dispose();
    if (!merged) throw new Error("[places] no se pudo fusionar la geometría del marcador");
    return merged;
  }, []);
}

type Marker = { id: string; label: string; sub: string; pos: [number, number]; colour: string };

function accessMarkers(accesses: Access[]): Marker[] {
  const TYPE_LABEL: Record<string, string> = {
    entrance: "Entrada",
    gate: "Portón",
    turnstile: "Torniquete",
    lift_gate: "Talanquera",
    sliding_gate: "Portón corredizo",
  };
  return accesses.map((a) => ({
    id: a.id,
    label: a.name ?? TYPE_LABEL[a.type] ?? "Acceso",
    sub: a.main ? "entrada principal" : (TYPE_LABEL[a.type] ?? a.type).toLowerCase(),
    pos: a.pos,
    colour: ACCESS_COLOUR[a.type] ?? ACCESS_COLOUR.entrance,
  }));
}

function serviceMarkers(services: Service[]): Marker[] {
  return services.map((s) => ({
    id: s.id,
    label: s.name ?? s.kind,
    sub: s.cuisine ? `${s.kind} · ${s.cuisine}` : s.kind,
    pos: s.pos,
    colour: SERVICE_COLOUR[s.category] ?? SERVICE_COLOUR.servicios,
  }));
}

function MarkerGroup({
  markers,
  geometry,
  onHover,
  hovered,
}: {
  markers: Marker[];
  geometry: THREE.BufferGeometry;
  onHover: (m: Marker | null) => void;
  hovered: Marker | null;
}) {
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        // El color real va por instancia; la base tiene que ser blanca para no teñirlo.
        color: 0xffffff,
        toneMapped: false,
      }),
    [],
  );

  const mesh = useMemo(() => {
    if (markers.length === 0) return null;
    const m = new THREE.InstancedMesh(geometry, material, markers.length);
    const matrix = new THREE.Matrix4();
    const colour = new THREE.Color();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);

    markers.forEach((mk, i) => {
      const [x, z] = shapeToWorldXZ(mk.pos);
      position.set(x, 0, z);
      matrix.compose(position, quaternion, scale);
      m.setMatrixAt(i, matrix);
      m.setColorAt(i, colour.set(mk.colour));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
    return m;
  }, [markers, geometry, material]);

  useEffect(() => {
    return () => {
      mesh?.dispose();
      material.dispose();
    };
  }, [mesh, material]);

  if (!mesh) return null;

  return (
    <>
      <primitive
        object={mesh}
        // Solo hover: no se llama a stopPropagation en el clic, así que un clic sobre
        // un marcador sigue llegando a onPointerMissed y deselecciona el edificio,
        // que es el comportamiento que ya tenía la escena.
        onPointerMove={(e: { instanceId?: number; stopPropagation: () => void }) => {
          e.stopPropagation();
          if (e.instanceId != null) onHover(markers[e.instanceId]);
        }}
        onPointerOut={() => onHover(null)}
      />
      {hovered && (
        <Html
          position={(() => {
            const [x, z] = shapeToWorldXZ(hovered.pos);
            return [x, PIN_HEIGHT + HEAD_RADIUS * 2.2, z];
          })()}
          center
          distanceFactor={140}
          zIndexRange={[60, 0]}
          style={{ pointerEvents: "none" }}
        >
          <div className="whitespace-nowrap rounded-md border border-white/20 bg-[#0f2038]/95 px-2 py-1 text-center backdrop-blur-sm">
            <div className="text-[11px] font-semibold leading-tight text-white">
              {hovered.label}
            </div>
            <div className="font-mono text-[9px] leading-tight text-slate-400">{hovered.sub}</div>
          </div>
        </Html>
      )}
    </>
  );
}

export function Places({
  places,
  showAccesses,
  showServices,
}: {
  places: PlacesData;
  showAccesses: boolean;
  showServices: boolean;
}) {
  const geometry = usePinGeometry();
  const accesses = useMemo(() => accessMarkers(places.accesses), [places.accesses]);
  const services = useMemo(() => serviceMarkers(places.services), [places.services]);
  const [hovered, setHovered] = useState<Marker | null>(null);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group>
      {showAccesses && (
        <MarkerGroup
          markers={accesses}
          geometry={geometry}
          onHover={setHovered}
          hovered={hovered && accesses.includes(hovered) ? hovered : null}
        />
      )}
      {showServices && (
        <MarkerGroup
          markers={services}
          geometry={geometry}
          onHover={setHovered}
          hovered={hovered && services.includes(hovered) ? hovered : null}
        />
      )}
    </group>
  );
}
