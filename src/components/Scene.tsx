"use client";

import { Line, OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Buildings, type PreparedBuilding } from "./Buildings";
import { Labels } from "./Labels";
import { buildCampusGround, campusOutlinePoints } from "@/lib/geometry";
import type { CampusData } from "@/lib/types";

/**
 * Todas las magnitudes de esta escena se derivan del tamaño real del campus
 * (meta.widthM × meta.depthM ≈ 393 × 590 m). Fijar niebla, zoom o volumen de
 * sombra a constantes pensadas para una escena de juguete es lo que dejaba el
 * prototipo anterior en pantalla negra: la cámara arrancaba a ~770 m con la
 * niebla cerrando a 260 m.
 */

function EnvironmentLighting() {
  const { gl, scene } = useThree();

  useEffect(() => {
    // RoomEnvironment es procedural: da reflejos creíbles al vidrio y al acero
    // sin descargar ningún HDR de un CDN externo.
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = new RoomEnvironment();
    const target = pmrem.fromScene(env, 0.04);
    scene.environment = target.texture;

    return () => {
      scene.environment = null;
      target.texture.dispose();
      pmrem.dispose();
      env.dispose?.();
    };
  }, [gl, scene]);

  return null;
}

function Sun({ radius }: { radius: number }) {
  const ref = useRef<THREE.DirectionalLight>(null);

  useEffect(() => {
    const light = ref.current;
    if (!light) return;
    // El ortho de sombra por defecto es de ±5 unidades. Sobre un campus de 600 m
    // eso significa que solo un parche de 10 m proyecta sombra — que es justo lo
    // que pasaba antes, pagando igual el coste del shadow map de 2048².
    const cam = light.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 1;
    cam.far = radius * 4;
    cam.updateProjectionMatrix();
  }, [radius]);

  return (
    <directionalLight
      ref={ref}
      position={[-radius * 0.8, radius * 1.25, radius * 0.55]}
      intensity={2.1}
      color="#fff2dc"
      castShadow
      shadow-mapSize={[2048, 2048]}
      shadow-bias={-0.0006}
      shadow-normalBias={0.6}
    />
  );
}

function Ground({ data, radius }: { data: CampusData; radius: number }) {
  const geometry = useMemo(() => buildCampusGround(data.campusOutline), [data.campusOutline]);
  const outline = useMemo(() => campusOutlinePoints(data.campusOutline, 0.6), [data.campusOutline]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group>
      {/* Contexto urbano fuera del campus */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.6, 0]} receiveShadow>
        <planeGeometry args={[radius * 6, radius * 6]} />
        <meshStandardMaterial color="#1b2733" roughness={1} />
      </mesh>

      {/* Superficie del campus, recortada con su contorno oficial (way/40739535) */}
      <mesh geometry={geometry} position={[0, 0, 0]} receiveShadow>
        <meshStandardMaterial color="#3f5c46" roughness={1} />
      </mesh>

      <Line points={outline} color="#7fa88a" lineWidth={1.5} transparent opacity={0.55} />
    </group>
  );
}

/**
 * Encuadre suave hacia el edificio enfocado. Trabaja sobre el target de OrbitControls
 * y conserva la distancia y el ángulo actuales del usuario, en vez de teletransportar
 * la cámara a una pose fija.
 */
function CameraRig({
  focus,
  radius,
}: {
  focus: { position: [number, number, number]; id: string } | null;
  radius: number;
}) {
  const controls = useThree((s) => s.controls) as
    | (THREE.EventDispatcher & { target: THREE.Vector3; update: () => void })
    | null;
  const camera = useThree((s) => s.camera);
  const goal = useRef<THREE.Vector3 | null>(null);
  const lastId = useRef<string | null>(null);

  useEffect(() => {
    if (!focus) return;
    if (focus.id === lastId.current) return;
    lastId.current = focus.id;
    goal.current = new THREE.Vector3(...focus.position);
  }, [focus]);

  useFrame((_, delta) => {
    if (!goal.current || !controls) return;

    const target = controls.target;
    const offset = camera.position.clone().sub(target);

    // Acercarse si estamos demasiado lejos para ver el edificio enfocado.
    const desired = Math.min(offset.length(), radius * 0.75);
    if (offset.length() > 1e-6) offset.setLength(desired);

    const t = 1 - Math.pow(0.0015, delta); // interpolación estable e independiente del framerate
    target.lerp(goal.current, t);
    camera.position.copy(target).add(offset);
    controls.update();

    if (target.distanceTo(goal.current) < 0.4) goal.current = null;
  });

  return null;
}

export type SceneProps = {
  data: CampusData;
  /**
   * La geometría se prepara fuera del Canvas: es matemática de BufferGeometry, no
   * necesita contexto WebGL. Así la lista lateral y el buscador funcionan aunque la
   * GPU falle, en vez de quedarse vacíos esperando a que monte la escena.
   */
  prepared: PreparedBuilding[];
  selectedId: string | null;
  hoveredId: string | null;
  showLabels: boolean;
  focus: { position: [number, number, number]; id: string } | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
};

export function Scene({
  data,
  prepared,
  selectedId,
  hoveredId,
  showLabels,
  focus,
  onSelect,
  onHover,
}: SceneProps) {
  const radius = Math.max(data.meta.widthM, data.meta.depthM) / 2;

  return (
    <>
      <color attach="background" args={["#0d1b2e"]} />
      {/* La niebla arranca más allá del campus completo: da profundidad sin ocultarlo. */}
      <fog attach="fog" args={["#0d1b2e", radius * 2.4, radius * 7]} />

      <EnvironmentLighting />
      <hemisphereLight args={["#bcd4f0", "#3a3428", 0.75]} />
      <Sun radius={radius} />

      <Ground data={data} radius={radius} />

      <Buildings
        prepared={prepared}
        selectedId={selectedId}
        onSelect={onSelect}
        onHover={onHover}
      />

      <Labels
        prepared={prepared}
        selectedId={selectedId}
        hoveredId={hoveredId}
        showLabels={showLabels}
      />

      <CameraRig focus={focus} radius={radius} />

      <OrbitControls
        makeDefault
        // Paneo habilitado: un campus de 600 m no se explora orbitando un punto fijo.
        enablePan
        screenSpacePanning={false}
        minDistance={25}
        maxDistance={radius * 5}
        // Un pelo por encima del horizonte, para no meter la cámara bajo el terreno.
        maxPolarAngle={Math.PI / 2 - 0.04}
        target={[0, 0, 0]}
      />
    </>
  );
}
