import { CampusExplorer } from "@/components/CampusExplorer";
import { campusData } from "@/lib/campus-data";
import { placesData } from "@/lib/places-data";
import { terrainData } from "@/lib/terrain-data";

/**
 * Los datasets se importan como módulos en vez de descargarse en runtime: evita el
 * waterfall de red y la dependencia de Overpass en cada visita.
 *
 * Para regenerarlos: `bun run osm:fetch` (volúmenes) y después `osm:terrain` (suelo)
 * y `osm:places` (accesos y servicios). El orden importa: los dos últimos leen el
 * origen de proyección del primero.
 */
export default function Page() {
  return <CampusExplorer data={campusData} terrain={terrainData} places={placesData} />;
}
