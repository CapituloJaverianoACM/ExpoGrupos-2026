"use client";

import { Line, OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, N8AO, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Buildings, type PreparedBuilding } from "./Buildings";
import { Labels } from "./Labels";
import { Terrain } from "./Terrain";
import { Places } from "./Places";
import { buildCampusGround, campusOutlinePoints } from "@/lib/geometry";
import type { CampusData, PlacesData, TerrainData } from "@/lib/types";

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

/**
 * Esfera envolvente de lo que proyecta sombra.
 *
 * Antes el frustum se dimensionaba con el radio del CAMPUS (295 m), que no es lo mismo
 * que la extensión de los volúmenes: estos llegan a z = +285 y a x = -193, así que la
 * esquina sur-oeste queda a 330 m del origen y se salía de la caja. Como el ortho está
 * orientado según la luz y no según los ejes del mundo, el recorte no era evidente —
 * simplemente algunos edificios del sur dejaban de proyectar.
 *
 * Se usa una esfera y no una caja precisamente porque es invariante a la orientación
 * de la luz: sirva cual sirva la dirección del sol, la cobertura está garantizada.
 */
function castingBounds(prepared: PreparedBuilding[]): { center: THREE.Vector3; radius: number } {
  const box = new THREE.Box3();
  for (const p of prepared) {
    const [x, z] = p.geometry.center;
    const r = p.geometry.footprintRadius;
    box.expandByPoint(new THREE.Vector3(x - r, 0, z - r));
    box.expandByPoint(new THREE.Vector3(x + r, p.geometry.top, z + r));
  }
  if (box.isEmpty()) return { center: new THREE.Vector3(), radius: 300 };

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  // Margen para el arbolado del borde, que también proyecta.
  const radius = size.length() / 2 + 40;
  return { center, radius };
}

function Sun({ bounds }: { bounds: { center: THREE.Vector3; radius: number } }) {
  const ref = useRef<THREE.DirectionalLight>(null);
  const { center, radius } = bounds;

  // El sol apunta al centro de los volúmenes, no al origen: el campus está descentrado
  // respecto a su bbox, y apuntar a [0,0,0] desperdicia parte del mapa de sombras.
  const position: [number, number, number] = [
    center.x - radius * 0.8,
    radius * 1.25,
    center.z + radius * 0.55,
  ];

  useEffect(() => {
    const light = ref.current;
    if (!light) return;

    // El `target` por defecto de DirectionalLight es un Object3D suelto que NO está en
    // el grafo de la escena, así que nadie le actualiza la matriz. Hay que hacerlo a
    // mano; si no, la luz apunta al origen pase lo que pase con `target.position`.
    light.target.position.copy(center);
    light.target.updateMatrixWorld();

    // El ortho de sombra por defecto es de ±5 unidades. Sobre un campus de 600 m
    // eso significa que solo un parche de 10 m proyecta sombra.
    const cam = light.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;

    // near/far ceñidos a la esfera. Con proyección ortográfica la profundidad es
    // lineal, así que no gana tanta precisión como ganaría en perspectiva, pero evita
    // gastar rango de profundidad en vacío delante y detrás del campus.
    const distance = light.position.distanceTo(center);
    cam.near = Math.max(distance - radius, 1);
    cam.far = distance + radius;
    cam.updateProjectionMatrix();
  }, [center, radius]);

  return (
    <directionalLight
      ref={ref}
      position={position}
      intensity={2.1}
      color="#fff2dc"
      castShadow
      // 4096² sobre un ortho de ~740 m da ~18 cm por texel, frente a los ~29 cm de
      // antes. Es lo que permite bajar el normalBias sin que aparezca acné.
      shadow-mapSize={[4096, 4096]}
      shadow-bias={-0.0004}
      // Era 0.6, o sea 60 cm de desplazamiento en la búsqueda de la sombra: suficiente
      // para despegarla visiblemente del pie de cada muro. Con el doble de resolución
      // se puede bajar y recuperar la sombra de contacto.
      shadow-normalBias={0.12}
    />
  );
}

function Ground({ data, radius }: { data: CampusData; radius: number }) {
  const geometry = useMemo(() => buildCampusGround(data.campusOutline), [data.campusOutline]);
  const outline = useMemo(() => campusOutlinePoints(data.campusOutline, 0.6), [data.campusOutline]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group>
      {/* Contexto urbano fuera del campus. Tiene que extenderse más allá del final de
          la niebla (radius*7): si no, se ve el borde del plano y el campus parece una
          isla flotando en el vacío al alejar la cámara. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.6, 0]} receiveShadow>
        <planeGeometry args={[radius * 20, radius * 20]} />
        <meshStandardMaterial color="#1b2733" roughness={1} />
      </mesh>

      {/* Superficie del campus, recortada con su contorno oficial (way/40739535).
          Tono neutro a propósito: antes era verde césped, lo que afirmaba que TODO el
          campus es zona verde. Desde que lib/terrain.ts dibuja las zonas verdes reales
          (landuse=grass, leisure=park), pintar la base de verde las volvía invisibles
          y exageraba la vegetación. Ahora el verde solo aparece donde OSM lo mapea. */}
      <mesh geometry={geometry} position={[0, 0, 0]} receiveShadow>
        <meshStandardMaterial color="#4c5349" roughness={1} />
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
function CameraRig({ focus, radius }: { focus: Focus | null; radius: number }) {
  const controls = useThree((s) => s.controls) as
    | (THREE.EventDispatcher & { target: THREE.Vector3; update: () => void })
    | null;
  const camera = useThree((s) => s.camera);
  const goal = useRef<THREE.Vector3 | null>(null);
  const goalDistance = useRef(0);
  const lastId = useRef<string | null>(null);

  useEffect(() => {
    if (!focus) return;
    if (focus.id === lastId.current) return;
    lastId.current = focus.id;
    goal.current = new THREE.Vector3(...focus.position);
    // La distancia se escala con el tamaño del edificio, no con el del campus:
    // una fracción fija del radio del campus deja la cámara pegada a los edificios
    // pequeños y demasiado lejos de los grandes.
    goalDistance.current = THREE.MathUtils.clamp(
      focus.extent * 3.2,
      55,
      radius * 1.6,
    );
  }, [focus, radius]);

  useFrame((_, delta) => {
    if (!goal.current || !controls) return;

    const target = controls.target;
    const offset = camera.position.clone().sub(target);
    const current = offset.length();
    if (current < 1e-6) return;

    // Elevación mínima al enfocar. Sin esto, volar desde un ángulo casi horizontal
    // mete la cámara DENTRO de los edificios que hay entre ella y el objetivo:
    // se acerca en línea recta y no hay nada que la aparte. Subirla por encima de
    // MIN_FOCUS_ELEVATION garantiza que mira el edificio desde arriba, despejada.
    const direction = offset.clone().normalize();
    const elevation = Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1));
    if (elevation < MIN_FOCUS_ELEVATION) {
      const azimuth = Math.atan2(direction.x, direction.z);
      const cos = Math.cos(MIN_FOCUS_ELEVATION);
      direction.set(
        Math.sin(azimuth) * cos,
        Math.sin(MIN_FOCUS_ELEVATION),
        Math.cos(azimuth) * cos,
      );
    }

    // Interpolación estable e independiente del framerate.
    const t = 1 - Math.pow(0.0015, delta);
    const nextDistance = THREE.MathUtils.lerp(current, goalDistance.current, t);
    const wanted = direction.multiplyScalar(nextDistance);
    offset.lerp(wanted, t);

    target.lerp(goal.current, t);
    camera.position.copy(target).add(offset);
    controls.update();

    if (
      target.distanceTo(goal.current) < 0.4 &&
      Math.abs(offset.length() - goalDistance.current) < 0.5
    ) {
      goal.current = null;
    }
  });

  return null;
}

/**
 * Compensa la barra lateral: sin esto el campus se centra en el canvas completo y queda
 * parcialmente tapado, porque 288 px de la izquierda están cubiertos por la lista.
 * `setViewOffset` desplaza la proyección, así que el raycasting sigue siendo coherente.
 */
function SidebarViewOffset({ left }: { left: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);

  useEffect(() => {
    const w = Math.round(size.width);
    const h = Math.round(size.height);
    if (w === 0 || h === 0) return;
    camera.setViewOffset(w, h, -left / 2, 0, w, h);
    camera.updateProjectionMatrix();
    return () => {
      camera.clearViewOffset();
      camera.updateProjectionMatrix();
    };
  }, [camera, size.width, size.height, left]);

  return null;
}

/**
 * Oclusión ambiental.
 *
 * Es lo que más aporta a un modelo de volúmenes SIN TEXTURA: sin oscurecimiento de
 * contacto, un patio interior recibe la misma luz ambiente que una fachada despejada
 * y todo se lee como cartón recortado. El AO reintroduce esa diferencia.
 *
 * Dos detalles que rompen esto si se tocan sin querer:
 *
 * 1. `@react-three/postprocessing` fuerza `gl.toneMapping = NoToneMapping` mientras el
 *    composer está montado (three, además, desactiva el tone mapping al renderizar a
 *    un render target). Si no se repone ACES al final de la cadena, la escena sale
 *    quemada. Por eso <ToneMapping> va SIEMPRE el último.
 * 2. `multisampling` usa render targets multimuestreados de WebGL2, así que el MSAA
 *    del canvas se conserva y no hace falta SMAA. Se baja de 8 a 4 porque el coste no
 *    se nota a cambio y esta escena son 276 volúmenes de aristas duras.
 */
function Effects({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;
  return (
    <EffectComposer multisampling={4}>
      <N8AO
        // En metros: es el alcance del oscurecimiento. Con 6 m se marcan el encuentro
        // muro-suelo, los patios y los retranqueos entre volúmenes, sin ensuciar las
        // fachadas planas. Muy por encima y el campus entero se ensombrece.
        aoRadius={6}
        distanceFalloff={1}
        intensity={2.4}
        // El ambiente de la escena es azulado (hemisphereLight #bcd4f0), así que la
        // oclusión tiene que tirar a frío. En negro puro se ve sucia, no sombreada.
        color="#101d2e"
        quality="medium"
        // A media resolución con reconstrucción por profundidad: el AO es de baja
        // frecuencia y la diferencia no se aprecia, pero el coste cae a la mitad.
        halfRes
        depthAwareUpsampling
        // Radio en mundo, no en pantalla: así el oscurecimiento de un patio es el
        // mismo tanto si se mira de cerca como desde los 885 m del zoom máximo.
        screenSpaceRadius={false}
      />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
    </EffectComposer>
  );
}

/** ~32°. Ángulo mínimo sobre el horizonte al que se sitúa la cámara al enfocar. */
const MIN_FOCUS_ELEVATION = 0.56;

export type Focus = {
  id: string;
  position: [number, number, number];
  /** Media diagonal de la huella del objetivo; determina a qué distancia encuadrar. */
  extent: number;
};

export type SceneProps = {
  data: CampusData;
  terrain: TerrainData;
  places: PlacesData;
  /**
   * La geometría se prepara fuera del Canvas: es matemática de BufferGeometry, no
   * necesita contexto WebGL. Así la lista lateral y el buscador funcionan aunque la
   * GPU falle, en vez de quedarse vacíos esperando a que monte la escena.
   */
  prepared: PreparedBuilding[];
  selectedId: string | null;
  hoveredId: string | null;
  showLabels: boolean;
  showTrees: boolean;
  showAO: boolean;
  showAccesses: boolean;
  showServices: boolean;
  focus: Focus | null;
  /** Ancho en px que la barra lateral tapa del canvas. */
  sidebarWidth: number;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
};

export function Scene({
  data,
  terrain,
  places,
  prepared,
  selectedId,
  hoveredId,
  showLabels,
  showTrees,
  showAO,
  showAccesses,
  showServices,
  focus,
  sidebarWidth,
  onSelect,
  onHover,
}: SceneProps) {
  const radius = Math.max(data.meta.widthM, data.meta.depthM) / 2;
  const bounds = useMemo(() => castingBounds(prepared), [prepared]);

  return (
    <>
      <color attach="background" args={["#0d1b2e"]} />
      {/* La niebla arranca más allá del campus completo: da profundidad sin ocultarlo. */}
      <fog attach="fog" args={["#0d1b2e", radius * 2.4, radius * 7]} />

      <EnvironmentLighting />
      <hemisphereLight args={["#bcd4f0", "#3a3428", 0.75]} />
      <Sun bounds={bounds} />

      <Ground data={data} radius={radius} />

      {/* Senderos, plazas, canchas y arbolado. Va después del suelo base y antes de
          los volúmenes: son superficies planas escalonadas en Y (ver lib/terrain.ts). */}
      <Terrain terrain={terrain} showTrees={showTrees} />

      <Buildings
        prepared={prepared}
        selectedId={selectedId}
        onSelect={onSelect}
        onHover={onHover}
      />

      <Places
        places={places}
        showAccesses={showAccesses}
        showServices={showServices}
      />

      <Labels
        prepared={prepared}
        selectedId={selectedId}
        hoveredId={hoveredId}
        showLabels={showLabels}
        campusRadius={radius}
        sidebarWidth={sidebarWidth}
      />

      <CameraRig focus={focus} radius={radius} />
      <SidebarViewOffset left={sidebarWidth} />

      <OrbitControls
        makeDefault
        // Paneo habilitado: un campus de 600 m no se explora orbitando un punto fijo.
        enablePan
        screenSpacePanning={false}
        minDistance={25}
        // radius*5 dejaba alejarse hasta ~1,5 km, donde el campus era una mancha
        // diminuta flotando en el vacío. radius*3 (~885 m) es lo justo para verlo
        // entero sin que sobre pantalla.
        maxDistance={radius * 3}
        // Un pelo por encima del horizonte, para no meter la cámara bajo el terreno.
        maxPolarAngle={Math.PI / 2 - 0.04}
        target={[0, 0, 0]}
      />

      <Effects enabled={showAO} />
    </>
  );
}
