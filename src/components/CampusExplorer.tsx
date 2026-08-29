"use client";

import { Canvas } from "@react-three/fiber";
import { useCallback, useMemo, useState } from "react";
import * as THREE from "three";
import { usePreparedBuildings, type PreparedBuilding } from "./Buildings";
import { Scene } from "./Scene";
import type { CampusData } from "@/lib/types";

type Props = { data: CampusData };

export function CampusExplorer({ data }: Props) {
  const prepared = usePreparedBuildings(data.buildings);
  const [webglFailed, setWebglFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [query, setQuery] = useState("");
  const [includeUnnamed, setIncludeUnnamed] = useState(false);
  const [focus, setFocus] = useState<{ position: [number, number, number]; id: string } | null>(
    null,
  );

  const radius = Math.max(data.meta.widthM, data.meta.depthM) / 2;

  const byId = useMemo(() => {
    const m = new Map<string, PreparedBuilding>();
    for (const p of prepared) m.set(p.building.id, p);
    return m;
  }, [prepared]);

  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    return prepared
      .filter((p) => !p.building.isPart)
      .filter((p) => includeUnnamed || p.building.name !== null)
      .filter((p) => {
        if (!q) return true;
        const label = p.building.name ?? p.building.id;
        return label.toLowerCase().includes(q) || p.building.kind.includes(q);
      })
      .sort((a, b) => {
        const an = a.building.name;
        const bn = b.building.name;
        if (an && bn) return an.localeCompare(bn, "es", { numeric: true });
        if (an) return -1;
        if (bn) return 1;
        return a.building.id.localeCompare(b.building.id);
      });
  }, [prepared, query, includeUnnamed]);

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (!id) return;
      const p = byId.get(id);
      // `center` es [x, z] del mundo; se apunta a media altura del volumen.
      if (p) {
        setFocus({
          id,
          position: [p.geometry.center[0], p.geometry.top * 0.5, p.geometry.center[1]],
        });
      }
    },
    [byId],
  );

  const selected = selectedId ? byId.get(selectedId) : undefined;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-[#0d1b2e] text-slate-100">
      {webglFailed ? (
        <div className="absolute inset-0 flex items-center justify-center p-8">
          <p className="max-w-md text-center text-sm leading-relaxed text-slate-300">
            No se pudo inicializar WebGL en este navegador, así que la vista 3D no está
            disponible. El listado de edificios de la izquierda sigue funcionando.
          </p>
        </div>
      ) : (
        <Canvas
          shadows
          dpr={[1, 2]}
          camera={{
            fov: 45,
            near: 1,
            far: radius * 12,
            position: [radius * 1.05, radius * 1.15, radius * 1.75],
          }}
          gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
          onPointerMissed={() => setSelectedId(null)}
          onCreated={({ gl }) => {
            gl.domElement.addEventListener("webglcontextlost", () => setWebglFailed(true));
          }}
        >
          <Scene
            data={data}
            prepared={prepared}
            selectedId={selectedId}
            hoveredId={hoveredId}
            showLabels={showLabels}
            focus={focus}
            onSelect={select}
            onHover={setHoveredId}
          />
        </Canvas>
      )}

      {/* ---------- Cabecera ---------- */}
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-[#0d1b2e]/95 to-transparent px-6 py-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-400">
            Explorador 3D · geometría real de OpenStreetMap
          </p>
          <h1 className="mt-0.5 text-lg font-bold">{data.meta.campusName}</h1>
        </div>
        <div className="text-right font-mono text-[10px] leading-relaxed text-slate-400">
          <p>
            <b className="text-orange-400">{data.meta.buildingCount}</b> volúmenes ·{" "}
            <b className="text-orange-400">{data.meta.namedCount}</b> con nombre
          </p>
          <p>
            {data.meta.widthM} × {data.meta.depthM} m
          </p>
        </div>
      </header>

      {/* ---------- Lista lateral ---------- */}
      <aside className="absolute bottom-8 left-0 top-24 flex w-72 flex-col border-r border-white/10 bg-[#0f2038]/85 backdrop-blur-md">
        <div className="border-b border-white/10 px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">
          Edificios · {listed.length}
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar edificio…"
          className="mx-3.5 mt-2.5 rounded-md border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs outline-none placeholder:text-slate-500 focus:border-orange-400/60"
        />

        <div className="mt-1 flex-1 overflow-y-auto py-1">
          {listed.map((p) => {
            const active = p.building.id === selectedId;
            return (
              <button
                key={p.building.id}
                type="button"
                onClick={() => select(p.building.id)}
                onMouseEnter={() => setHoveredId(p.building.id)}
                onMouseLeave={() => setHoveredId(null)}
                className={[
                  "block w-full border-l-2 px-4 py-1.5 text-left text-xs leading-snug transition-colors",
                  active
                    ? "border-orange-400 bg-white/10 text-white"
                    : "border-transparent text-slate-200 hover:bg-white/5",
                ].join(" ")}
              >
                {p.building.name ?? <span className="text-slate-400">Sin nombre en OSM</span>}
                <span className="mt-0.5 block font-mono text-[9.5px] text-slate-400">
                  {p.building.kind} · {p.building.height} m
                  {p.building.levels ? ` · ${p.building.levels} niveles` : ""}
                </span>
              </button>
            );
          })}
          {listed.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-slate-400">Sin coincidencias.</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5 border-t border-white/10 p-3">
          <Toggle
            label="Etiquetas"
            on={showLabels}
            onClick={() => setShowLabels((v) => !v)}
          />
          <Toggle
            label="Incluir sin nombre"
            on={includeUnnamed}
            onClick={() => setIncludeUnnamed((v) => !v)}
          />
          <button
            type="button"
            onClick={() => {
              setSelectedId(null);
              setFocus({ id: `reset:${Date.now()}`, position: [0, 0, 0] });
            }}
            className="rounded-md border border-white/15 bg-white/5 px-2.5 py-2 text-left font-mono text-[10.5px] hover:bg-white/10"
          >
            Centrar campus ↺
          </button>
        </div>
      </aside>

      {/* ---------- Ficha del edificio ---------- */}
      {selected && (
        <section className="absolute bottom-12 right-4 w-80 rounded-xl border border-white/15 bg-[#0f2038]/90 p-4 backdrop-blur-md">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="absolute right-3 top-2.5 text-slate-400 hover:text-white"
            aria-label="Cerrar"
          >
            ✕
          </button>
          <h2 className="mb-2 pr-6 text-base font-bold leading-tight">
            {selected.building.name ?? "Edificio sin nombre en OSM"}
          </h2>
          <Row label="Tipo (OSM)" value={selected.building.kind} />
          <Row label="Niveles" value={selected.building.levels?.toString() ?? "—"} />
          <Row label="Altura" value={`${selected.building.height} m`} />
          {selected.building.minHeight > 0 && (
            <Row label="Arranca a" value={`${selected.building.minHeight} m`} />
          )}
          <Row label="Material" value={selected.building.material ?? "—"} />
          <Row
            label="Color"
            value={
              selected.building.colour ? (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-3 w-3 rounded-sm border border-white/25"
                    style={{ background: selected.building.colour }}
                  />
                  {selected.building.colour}
                </span>
              ) : (
                "—"
              )
            }
          />
          <Row
            label="Tejado"
            value={
              selected.building.roofShape
                ? `${selected.building.roofShape}${selected.building.roofHeight ? ` · ${selected.building.roofHeight} m` : ""}`
                : "plano"
            }
          />
          <a
            href={`https://www.openstreetmap.org/${selected.building.id}`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block border-t border-white/10 pt-2 font-mono text-[10px] text-slate-400 hover:text-orange-400"
          >
            {selected.building.id} · ver en OSM ↗
          </a>
        </section>
      )}

      <footer className="absolute inset-x-0 bottom-0 bg-[#0d1b2e]/85 py-1 text-center font-mono text-[9.5px] text-slate-400">
        Datos ©{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted"
        >
          OpenStreetMap contributors
        </a>{" "}
        (ODbL) · instantánea del {new Date(data.meta.fetchedAt).toLocaleDateString("es-CO")}
      </footer>
    </div>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-between rounded-md border border-white/15 bg-white/5 px-2.5 py-2 font-mono text-[10.5px] hover:bg-white/10"
    >
      {label}
      <span className={on ? "text-orange-400" : "text-slate-500"}>{on ? "ON" : "OFF"}</span>
    </button>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-t border-white/10 py-1.5 font-mono text-[10.5px] text-slate-400">
      <span>{label}</span>
      <span className="text-right font-sans text-slate-100">{value}</span>
    </div>
  );
}
