"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import {
  buildAreaLayers,
  buildPathLayers,
  buildTreeInstances,
  type TreeInstance,
} from "@/lib/terrain";
import { areaMaterial, crownColour, pathMaterial, treeMaterials } from "@/lib/terrain-materials";
import type { TerrainData } from "@/lib/types";

/**
 * Capa de suelo: zonas verdes, canchas, plazas, senderos, escaleras y arbolado.
 *
 * Nada de esto es interactivo — no lleva handlers de puntero, así que r3f ni siquiera
 * lo incluye en el raycasting y un clic en el suelo sigue deseleccionando el edificio
 * activo, como antes de que esta capa existiera.
 */

/** Geometrías unitarias del árbol, con la base ya en y = 0 para que la matriz sea escala pura. */
function useTreeGeometries() {
  return useMemo(() => {
    // 6 lados bastan: un tronco de 45 cm de diámetro visto desde 300 m no da para más.
    const trunk = new THREE.CylinderGeometry(0.75, 1, 1, 6, 1, false);
    trunk.translate(0, 0.5, 0);

    // Icosaedro de detalle 1 (80 caras) como copa de frondosa. Una esfera UV costaría
    // el triple de vértices para una silueta que se lee igual.
    const broadleaf = new THREE.IcosahedronGeometry(1, 1);

    const conifer = new THREE.ConeGeometry(1, 1, 7, 1, false);
    conifer.translate(0, 0.5, 0);

    return { trunk, broadleaf, conifer };
  }, []);
}

function makeInstanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  instances: TreeInstance[],
  place: (t: TreeInstance, m: THREE.Matrix4) => void,
  colourize: boolean,
): THREE.InstancedMesh | null {
  if (instances.length === 0) return null;

  const mesh = new THREE.InstancedMesh(geometry, material, instances.length);
  const matrix = new THREE.Matrix4();
  const colour = new THREE.Color();

  instances.forEach((t, i) => {
    place(t, matrix);
    mesh.setMatrixAt(i, matrix);
    if (colourize) mesh.setColorAt(i, crownColour(t.tint, t.conifer, colour));
  });

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Los árboles no se mueven: sin esto three recalcularía la bounding sphere del
  // conjunto en cada frame para el frustum culling.
  mesh.frustumCulled = true;
  mesh.computeBoundingSphere();
  return mesh;
}

function Trees({ instances }: { instances: TreeInstance[] }) {
  const geo = useTreeGeometries();

  const meshes = useMemo(() => {
    const { trunk: trunkMat, crown: crownMat } = treeMaterials();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    const broadleaves = instances.filter((t) => !t.conifer);
    const conifers = instances.filter((t) => t.conifer);

    const trunks = makeInstanced(
      geo.trunk,
      trunkMat,
      instances,
      (t, m) => {
        const r = Math.max(t.height * 0.025, 0.08);
        // El tronco entra un poco en la copa para que no se vea la junta.
        position.set(t.position[0], 0, t.position[2]);
        quaternion.setFromAxisAngle(up, t.rotation);
        scale.set(r, t.crownBase * 1.15, r);
        m.compose(position, quaternion, scale);
      },
      false,
    );

    const broadleafCrowns = makeInstanced(
      geo.broadleaf,
      crownMat,
      broadleaves,
      (t, m) => {
        const half = (t.height - t.crownBase) / 2;
        position.set(t.position[0], t.crownBase + half, t.position[2]);
        quaternion.setFromAxisAngle(up, t.rotation);
        scale.set(t.crownRadius, half, t.crownRadius);
        m.compose(position, quaternion, scale);
      },
      true,
    );

    const coniferCrowns = makeInstanced(
      geo.conifer,
      crownMat,
      conifers,
      (t, m) => {
        position.set(t.position[0], t.crownBase, t.position[2]);
        quaternion.setFromAxisAngle(up, t.rotation);
        scale.set(t.crownRadius, t.height - t.crownBase, t.crownRadius);
        m.compose(position, quaternion, scale);
      },
      true,
    );

    return [trunks, broadleafCrowns, coniferCrowns].filter(
      (m): m is THREE.InstancedMesh => m !== null,
    );
  }, [geo, instances]);

  useEffect(() => {
    return () => {
      for (const m of meshes) m.dispose();
    };
  }, [meshes]);

  useEffect(() => {
    return () => {
      geo.trunk.dispose();
      geo.broadleaf.dispose();
      geo.conifer.dispose();
    };
  }, [geo]);

  return (
    <group>
      {meshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
    </group>
  );
}

export function Terrain({ terrain, showTrees }: { terrain: TerrainData; showTrees: boolean }) {
  const areas = useMemo(() => buildAreaLayers(terrain.areas), [terrain.areas]);
  const paths = useMemo(() => buildPathLayers(terrain.paths), [terrain.paths]);
  const trees = useMemo(() => buildTreeInstances(terrain.trees), [terrain.trees]);

  useEffect(() => {
    return () => {
      for (const l of areas) l.geometry.dispose();
      for (const l of paths) l.geometry.dispose();
    };
  }, [areas, paths]);

  return (
    <group>
      {areas.map(({ key, geometry }) => (
        <mesh key={`a:${key}`} geometry={geometry} material={areaMaterial(key)} receiveShadow />
      ))}
      {paths.map(({ key, geometry }) => (
        <mesh key={`p:${key}`} geometry={geometry} material={pathMaterial(key)} receiveShadow />
      ))}
      {showTrees && <Trees instances={trees} />}
    </group>
  );
}
